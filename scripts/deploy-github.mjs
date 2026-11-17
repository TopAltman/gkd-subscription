#!/usr/bin/env node
/**
 * GitHub 一键部署 —— 建仓（可选）+ 配置地址 + 构建 + 推送 + 跟踪 CI。
 *
 * ## 为什么单独写这个脚本
 *
 * 长期部署要踩的坑集中在一个地方：**订阅文件内部的 updateUrl 必须和对外地址一致**。
 * 前面几步（改地址、重新构建、推送、等 CI、验证）任何一步漏了，
 * 症状都是「订阅能加、但自动更新永远失败」—— 表面完全看不出来。
 * 所以这个脚本把整条链路串成一步，并且最后一定要跑 `check-deployment.mjs` 验收。
 *
 * ## 用法
 *
 *   # 1. 只做本地准备（改地址 + 构建），推送和建仓自己做
 *   node ./scripts/deploy-github.mjs --account <账号> --repo <仓库>
 *
 *   # 2. 完整部署（需要 token）
 *   GITHUB_TOKEN=ghp_xxx node ./scripts/deploy-github.mjs \
 *     --account <账号> --repo <仓库> --create-repo
 *
 * ## 关于 token 的处理
 *
 * token 只从环境变量 GITHUB_TOKEN 读，**不写入任何文件**：
 *   - 不进 .git/config（推送用 `-c http.extraHeader` 一次性传）
 *   - 不进 shell 历史（脚本内部处理）
 *   - 不进产物（产物里只有订阅内容）
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const hasFlag = (n) => args.includes(`--${n}`);

const log = (...a) => console.log('[deploy]', ...a);
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.warn(`  ! ${m}`);
const die = (m) => {
  console.error(`[deploy][fatal] ${m}`);
  process.exit(1);
};

const ACCOUNT = getArg('account', process.env.GITHUB_ACCOUNT ?? '');
const REPO = getArg('repo', process.env.GITHUB_REPO ?? '');
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const CREATE_REPO = hasFlag('create-repo');
const PAGES = hasFlag('pages');

if (!ACCOUNT) die('缺少 --account（GitHub 账号名）');
if (!REPO) die('缺少 --repo（仓库名）');

/* ------------------------------------------------------------------ */
/* 1. 配置订阅地址                                                     */
/* ------------------------------------------------------------------ */

const baseUrl = PAGES
  ? `https://${ACCOUNT}.github.io/${REPO}`
  : `https://raw.githubusercontent.com/${ACCOUNT}/${REPO}/main/dist`;

log(`目标地址: ${baseUrl}`);

const configPath = path.join(ROOT, 'subscription.config.json');
const configText = await readFile(configPath, 'utf8');
// 用正则替换，保留 JSON5 里的注释字段
const newConfig = configText.replace(
  /"baseUrl"\s*:\s*"[^"]*"/,
  `"baseUrl": ${JSON.stringify(baseUrl)}`,
);
if (newConfig === configText && !configText.includes(baseUrl)) {
  die(`subscription.config.json 里找不到 baseUrl 字段，请检查文件格式`);
}
await writeFile(configPath, newConfig, 'utf8');
ok(`已更新 subscription.config.json 的 baseUrl`);

/* ------------------------------------------------------------------ */
/* 2. 构建                                                             */
/* ------------------------------------------------------------------ */

log('重新构建订阅产物…');
try {
  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/rules-aggregator/aggregate.mjs'), '--strict-url'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const m = out.match(/合并完成：.*/);
  ok(m ? m[0] : '构建完成');
} catch (e) {
  console.error(e.stdout ?? '');
  console.error(e.stderr ?? '');
  die('构建失败');
}

/* ------------------------------------------------------------------ */
/* 3. 建仓（可选）                                                     */
/* ------------------------------------------------------------------ */

if (CREATE_REPO) {
  if (!TOKEN) die('--create-repo 需要设置 GITHUB_TOKEN 环境变量');
  if (!ACCOUNT || !REPO) die('建仓需要 --account 与 --repo');
  log(`创建仓库 ${ACCOUNT}/${REPO}…`);
  const res = await fetch(`https://api.github.com/user/repos`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'gkd-subscription-deploy',
    },
    body: JSON.stringify({
      name: REPO,
      description: 'GKD 开屏广告规则聚合订阅',
      private: false,
      auto_init: false,
    }),
  });
  if (res.status === 422) {
    warn('仓库已存在，跳过创建');
  } else if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body.message ?? '';
    // 两种常见原因，各给一条可操作的出路
    if (res.status === 403 && /permission|resource not accessible/i.test(msg)) {
      die(
        `创建仓库失败（权限不足）: ${msg}\n` +
          `  · fine-grained token 需额外勾选 Repository permissions → ` +
          `"Repository creation: Write"\n` +
          `  · 或者改用 classic token 勾 "public_repo" scope\n` +
          `  · 最省事：自己在网页上建一个空仓库（不要勾 README），` +
          `然后重跑本命令（去掉 --create-repo）`,
      );
    }
    if (/verify/i.test(msg) || /email/i.test(msg)) {
      die(
        `创建仓库失败（邮箱未验证）: ${msg}\n` +
          `  GitHub 要求先验证邮箱才能创建仓库。\n` +
          `  去 Gmail 收件箱点验证链接，再重跑本命令。`,
      );
    }
    die(`创建仓库失败: HTTP ${res.status} ${msg}`);
  } else {
    ok(`仓库已创建: https://github.com/${ACCOUNT}/${REPO}`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. 推送                                                             */
/* ------------------------------------------------------------------ */

if (!TOKEN) {
  warn('未设置 GITHUB_TOKEN，跳过推送。请自行执行：');
  console.log(`
  cd gkd-pipeline
  git init -b main
  git add .
  git commit -m "feat: 规则聚合订阅"
  git remote add origin https://github.com/${ACCOUNT}/${REPO}.git
  git push -u origin main

  然后在仓库 Settings → Actions → General → Workflow permissions 选
  "Read and write permissions"（CI 需要它把产物提交回 main）。
`);
  process.exit(0);
}

log('推送到 GitHub…');
const authHeader = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const gitOpts = {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
};

function git(args, extraOpts = {}) {
  return execFileSync('git', args, {
    ...gitOpts,
    ...extraOpts,
  });
}

try {
  // token 不写进 .git/config —— 用一次性的 http.extraHeader
  const extra = ['-c', `http.extraHeader=${authHeader}`];
  git(['status', '--porcelain'], { cwd: ROOT });
  try {
    git(['rev-parse', '--git-dir'], { cwd: ROOT });
  } catch {
    git(['init', '-b', 'main'], { cwd: ROOT });
    warn('已初始化 git 仓库');
  }
  // 分支名必须叫 main —— GitHub 默认分支、CI 的 push 触发条件、
  // 以及 baseUrl 里的 /main/dist 都按这个来。
  // 本地是 master 时直接改名，比新建分支更安全（不会丢提交）。
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT }).trim();
  if (branch !== 'main') {
    git(['branch', '-M', 'main'], { cwd: ROOT });
    warn(`已把分支 ${branch} 改名为 main`);
  }
  git(['add', '-A'], { cwd: ROOT });
  try {
    git(['commit', '-m', 'feat: 规则聚合订阅'], { cwd: ROOT });
  } catch (e) {
    if (!/nothing to commit/i.test(e.stdout + e.stderr)) throw e;
    warn('没有需要提交的改动');
  }
  // 设置远端
  const remotes = git(['remote'], { cwd: ROOT });
  if (!remotes.includes('origin')) {
    git(['remote', 'add', 'origin', `https://github.com/${ACCOUNT}/${REPO}.git`], {
      cwd: ROOT,
    });
  } else {
    git(['remote', 'set-url', 'origin', `https://github.com/${ACCOUNT}/${REPO}.git`], {
      cwd: ROOT,
    });
  }
  // 显式 refspec，避免分支名不一致时的 refspec 报错
  git([...extra, 'push', '-u', 'origin', 'HEAD:refs/heads/main'], { cwd: ROOT });
  ok(`已推送到 https://github.com/${ACCOUNT}/${REPO}`);
} catch (e) {
  console.error(e.stdout ?? '');
  console.error(e.stderr ?? '');
  console.error(e.message ?? '');
  die(
    '推送失败。常见原因：\n' +
      '  · 令牌权限不足（fine-grained 需 Contents: Read and write）\n' +
      '  · 仓库名已存在但不属于当前账号\n' +
      '  · 网络问题（可重试）',
  );
}

/* ------------------------------------------------------------------ */
/* 5. 跟踪 CI 并验收                                                   */
/* ------------------------------------------------------------------ */

log('等待 GitHub Actions 跑完…');
let lastStatus = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const res = await fetch(
    `https://api.github.com/repos/${ACCOUNT}/${REPO}/actions/runs?per_page=3`,
    {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'gkd-subscription-deploy',
      },
    },
  );
  if (!res.ok) {
    warn(`查询 CI 状态失败: HTTP ${res.status}`);
    continue;
  }
  const body = await res.json();
  const run = body.workflow_runs?.[0];
  if (!run) continue;
  if (run.status !== 'completed') {
    if (lastStatus !== run.status) {
      log(`  CI 状态: ${run.status}`);
      lastStatus = run.status;
    }
    continue;
  }
  if (run.conclusion === 'success') {
    ok('CI 跑通');
    break;
  }
  die(`CI 失败: ${run.conclusion} —— ${run.html_url}`);
}

log('开始验收部署结果…');
try {
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/check-deployment.mjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
  );
} catch {
  die('部署验收未通过 —— 见上面的检查项');
}

log('');
log('✅ 部署完成');
log(`   订阅地址: ${baseUrl}/gkd.json5`);
log('   在 GKD 客户端「订阅 → +」粘贴上面的地址');
if (PAGES) {
  log('');
  log('   ⚠️ 还需要一步：仓库 Settings → Pages → Source 选 GitHub Actions');
  log('      （不选的话 Pages 部署会失败，raw 那份仍然可用）');
}
