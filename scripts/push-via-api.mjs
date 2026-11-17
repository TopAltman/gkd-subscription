#!/usr/bin/env node
/**
 * 通过 GitHub REST API 推送整个仓库（不经过 git 协议）。
 *
 * ## 为什么需要这个
 *
 * `git push` 走的是 `https://github.com/...` 的 git smart-HTTP 端点。
 * 很多网络环境（包括公司代理、部分国内网络）能正常访问 `api.github.com`，
 * 却把 `github.com` 卡掉 —— 表现是：
 *
 *   git push → fatal: unable to access 'https://github.com/.../': CONNECT tunnel failed, response 502
 *   curl https://api.github.com/ → 200
 *
 * 而 REST API 走的是另一个域名，完全可用。
 * 所以这里用 **Git Data API** 直接操作 Git 数据库：
 *
 *   1. POST /repos/{o}/{r}/git/blobs   —— 大文件先建成 blob
 *   2. POST /repos/{o}/{r}/git/trees   —— 一次提交全部条目
 *   3. POST /repos/{o}/{r}/git/commits —— 生成提交
 *   4. PATCH /repos/{o}/{r}/git/refs/heads/{branch} —— 推进分支指针
 *
 * 需要的令牌权限：**Contents: Read and write**（fine-grained token 的 Repository permissions）。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node ./scripts/push-via-api.mjs --account <账号> --repo <仓库>
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const log = (...a) => console.log('[push-api]', ...a);
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => {
  console.error(`[push-api][fatal] ${m}`);
  process.exit(1);
};

const ACCOUNT = getArg('account', process.env.GITHUB_ACCOUNT ?? '');
const REPO = getArg('repo', process.env.GITHUB_REPO ?? '');
const BRANCH = getArg('branch', 'main');
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const MESSAGE = getArg('message', 'feat: 规则聚合订阅');

if (!ACCOUNT) die('缺少 --account');
if (!REPO) die('缺少 --repo');
if (!TOKEN) die('缺少 GITHUB_TOKEN 环境变量');

const API = `https://api.github.com/repos/${ACCOUNT}/${REPO}`;
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'gkd-subscription-push',
  'x-github-api-version': '2022-11-28',
};

/* ------------------------------------------------------------------ */
/* 收集文件                                                            */
/* ------------------------------------------------------------------ */

const IGNORE_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'release']);

/**
 * 递归收集要上传的文件。
 * @returns {Promise<Array<{path:string, abs:string, size:number}>>}
 */
async function collect(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...(await collect(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile()) {
      const abs = path.join(dir, entry.name);
      const info = await stat(abs);
      out.push({ path: `${prefix}${entry.name}`, abs, size: info.size });
    }
  }
  return out;
}

const files = (await collect(ROOT)).sort((a, b) => a.path.localeCompare(b.path));
log(`待上传 ${files.length} 个文件`);

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

/**
 * 带退避重试的 API 调用。
 *
 * 必须重试的原因：GitHub 对「写内容」类端点有**二级速率限制**
 * （secondary rate limit），触发时不走主限额（/rate_limit 显示还有 4991 次），
 * 而是直接返回 403/429，且**报错信息具有误导性** ——
 * 同样一个 create-tree 请求，可能报：
 *   - "You have exceeded a secondary rate limit"
 *   - "Resource not accessible by personal access token"   ← 完全是误导
 * 两种都按「限流」处理即可。
 */
async function api(pathname, init = {}, { retries = 6 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API}${pathname}`, {
        ...init,
        headers: { ...HEADERS, ...(init.headers ?? {}) },
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON */
      }
      if (!res.ok) {
        const msg = body?.message ?? text.slice(0, 300);
        const err = new Error(`${init.method ?? 'GET'} ${pathname} → HTTP ${res.status}: ${msg}`);
        err.status = res.status;
        err.body = body;
        // 403/429 视为限流或权限问题，退避后重试
        if (res.status === 403 || res.status === 429) {
          lastErr = err;
          const wait = Math.min(60_000, 3000 * 2 ** (attempt - 1));
          log(`  遇限流，${Math.round(wait / 1000)}s 后重试 (${attempt}/${retries}): ${msg.slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
      return body;
    } catch (e) {
      if (e.status === 403 || e.status === 429) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error(`${init.method ?? 'GET'} ${pathname} 失败`);
}

/* 0. 空仓库需要先用 Contents API 引导出首个提交 ——
 * Git Data API 的 blob/tree 端点在空仓库上会返回 409 "Git Repository is empty"。 */
let parentSha = null;
const head = await fetch(`${API}/commits?per_page=1`, { headers: HEADERS })
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => []);
if (head.length > 0) {
  parentSha = head[0].sha;
  log(`已有提交，基准: ${parentSha.slice(0, 8)}`);
} else {
  log('空仓库，先用 Contents API 引导首个提交…');
  const init = await api('/contents/.gitkeep', {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore: 初始化仓库',
      content: Buffer.from('').toString('base64'),
    }),
  });
  parentSha = init.commit?.sha;
  if (!parentSha) die('初始化提交失败');
  ok(`已创建初始提交: ${parentSha.slice(0, 8)}`);
}

/* 1. 准备 tree 条目。
 *
 * 小文件直接内联 content（一次 tree 请求搞定，省 300+ 次 API 调用），
 * 大文件先建成 blob 再引用 sha（内联的大文件会让 tree 请求体过大）。
 *
 * ⚠️ 一个必须绕开的坑：**`.github/workflows/` 下的文件被 GitHub 保护**，
 * 修改它们需要令牌带 `Workflows: write` 权限，否则 create-tree 直接返回
 * 403 "Resource not accessible by personal access token"。
 * 这个报错极具误导性 —— 实测同一份内容换个路径就 201 了。
 * 所以这里把 workflow 文件单独摘出来，权限不够时先推其余文件并明确提示。
 */
const WORKFLOW_DIR = '.github/workflows/';
const isWorkflow = (p) => p.startsWith(WORKFLOW_DIR);
const workflowFiles = files.filter((f) => isWorkflow(f.path));
// 默认把 workflow 一起推；令牌缺 "Workflows: write" 时会自动回退到不含 workflow 的版本。
const otherFiles = files.filter((f) => !isWorkflow(f.path));

const INLINE_LIMIT = 200 * 1024;
const treeEntries = [];
let blobCount = 0;

const allFiles = [...otherFiles, ...workflowFiles];
for (const f of allFiles) {
  if (f.size <= INLINE_LIMIT && !isWorkflow(f.path)) {
    treeEntries.push({
      path: f.path,
      mode: '100644',
      type: 'blob',
      content: await readFile(f.abs, 'utf8'),
    });
  } else {
    const buf = await readFile(f.abs);
    const blob = await api('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    blobCount++;
  }
}
ok(
  `tree 条目就绪：${treeEntries.length} 项` +
    `（${blobCount} 个走 blob，含 ${workflowFiles.length} 个 workflow 文件）`,
);

/* 2. 建树 */
log('创建 tree…');
if (process.env.DEBUG_TREE_OUT) {
  await writeFile(process.env.DEBUG_TREE_OUT, JSON.stringify({ tree: treeEntries }), 'utf8');
}
let tree;
const entriesWithoutWorkflow = treeEntries.filter((e) => !isWorkflow(e.path));
try {
  tree = await api('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ tree: treeEntries }),
  });
  if (workflowFiles.length) ok(`已包含 ${workflowFiles.length} 个 workflow 文件`);
} catch (e) {
  if (!workflowFiles.length) die(`创建 tree 失败: ${e.message}`);
  // 极可能是令牌缺 "Workflows: write"（GitHub 对 .github/workflows/ 的保护）。
  // 这个报错信息极具误导性 —— 实测同一份内容换个路径就 201 了。
  warn(`带 workflow 建 tree 失败（${e.message}）`);
  warn('多半是令牌缺少 "Workflows: write" 权限 —— 先推其余文件，workflow 稍后补。');
  tree = await api('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ tree: entriesWithoutWorkflow }),
  });
  workflowFiles.length = 0;
}
ok(`tree: ${tree.sha}（${tree.tree?.length ?? '?'} 项）`);

/* 3. 建提交 */
log('创建 commit…');
const commit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({
    message: MESSAGE,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  }),
});
ok(`commit: ${commit.sha}`);

/* 4. 推进分支指针 */
log(`更新分支 ${BRANCH}…`);
try {
  await api(`/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
} catch (e) {
  if (/404|Reference does not exist/i.test(e.message)) {
    await api('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
    });
  } else {
    throw e;
  }
}
ok(`分支 ${BRANCH} → ${commit.sha}`);

log('');
log('✅ 推送完成');
log(`   https://github.com/${ACCOUNT}/${REPO}`);
