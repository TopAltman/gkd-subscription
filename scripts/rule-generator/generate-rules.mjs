#!/usr/bin/env node
/**
 * 规则生成 CLI —— 把一份抓到的快照变成一条经过校验的 GKD 规则。
 *
 * ## 为什么需要它
 *
 * 交接包的 package.json 里挂着 `npm run gen:rules`，
 * 但 scripts/rules-aggregator/generate-rules.mjs 这个文件**并不存在** ——
 * 跑起来直接 MODULE_NOT_FOUND。整条流水线的「生成」环节因此没有独立入口：
 * 只能启动 HTTP 服务端、走 /report → /generate 两步 HTTP 才能生成一条规则。
 *
 * 这个脚本补上这个缺口：本地拿一份快照文件，一条命令产出规则，
 * 校验器把关，通过才落库到 rules/local/。
 *
 * ## 用法
 *
 *   # 生成并写入 rules/local/
 *   node ./scripts/rule-generator/generate-rules.mjs --snapshot fixtures/snapshots/pos-com.tencent.mm.json
 *
 *   # 只看结果不落库
 *   node ./scripts/rule-generator/generate-rules.mjs --snapshot xxx.json --dry-run
 *
 *   # 用指定模型的 key
 *   LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node ./scripts/rule-generator/generate-rules.mjs --snapshot xxx.json
 *
 * ## 输入格式
 *
 * 接受以下任一：
 *   1. 语料库快照（fixtures/snapshots/*.json）：含 appId / tree / kind
 *   2. GKD 客户端导出的审查快照：含 appId / tree（字段名兼容 camelCase 与 snake_case）
 *
 * ## 安全约束（与服务端一致）
 *
 *   - 生成的候选必须全部经过校验器：语法 + 目标快照命中 + 同 App 非开屏页不误触 + id 归属
 *   - 任何一条候选都没通过 → 不落库，退出码 1
 *   - 落库前写入 rules/local/<包名>.json5，由聚合器的 CI 收进产物
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRule } from '../rule-validator/validate.mjs';
import { callLLM } from '../../server/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const log = (...a) => console.log('[generate]', ...a);
const warn = (...a) => console.warn('[generate][warn]', ...a);

const SNAPSHOT = getArg('snapshot', null);
const APP_ID = getArg('app-id', null);
const OUT_DIR = path.resolve(ROOT, getArg('out', 'rules/local'));
const FIXTURE_DIR = path.resolve(ROOT, getArg('fixtures', 'fixtures/snapshots'));
const DRY_RUN = args.includes('--dry-run');

/**
 * 归一化不同来源的快照文件。
 * @returns {{appId:string, tree:object, activityId?:string, expect?:object}|null}
 */
export function normalizeSnapshot(raw) {
  const tree = raw.tree ?? raw.root ?? null;
  if (!tree) return null;
  const appId = raw.appId ?? raw.packageName ?? raw.package ?? null;
  if (!appId) return null;
  // GKD 客户端导出的属性名可能是 snake_case，统一成校验器认的 camelCase
  const normalizeNode = (n) => {
    if (!n || typeof n !== 'object') return n;
    const attrs = {};
    for (const [k, v] of Object.entries(n.attributes ?? {})) {
      const camel = k
        .replace(/_([a-z])/g, (_, c) => c.toUpperCase())
        .replace(/^viewIdResourceName$/, 'id');
      attrs[camel] = v;
    }
    return {
      name: n.name ?? n.className ?? 'android.view.View',
      attributes: attrs,
      children: (n.children ?? []).map(normalizeNode),
    };
  };
  const expect = raw.expect ?? null;
  return {
    appId: String(appId),
    activityId: raw.activityId ?? raw.activity ?? undefined,
    expect,
    tree: normalizeNode(tree),
  };
}

/** 载入全部快照作为负样本池。 */
async function loadSnapshotPool() {
  const out = [];
  if (!existsSync(FIXTURE_DIR)) return out;
  for (const f of await readdir(FIXTURE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, f), 'utf8'));
      const n = normalizeSnapshot(raw);
      if (!n) continue;
      out.push({
        file: f,
        appId: n.appId,
        activityId: n.activityId,
        expect: n.expect,
        tree: n.tree,
        kind: raw.kind ?? 'unknown',
      });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out;
}

async function main() {
  if (!SNAPSHOT) {
    console.error('用法: --snapshot <快照文件> [--app-id <包名>] [--out <目录>] [--dry-run]');
    process.exit(1);
  }

  // 干跑模式用模拟候选，不需要 API key
  if (!process.env.LLM_API_KEY && !DRY_RUN) {
    console.error('[generate][fatal] 未配置 LLM_API_KEY，无法调用模型');
    console.error('（想先验证链路可用 --dry-run 走模拟候选）');
    process.exit(1);
  }

  const raw = JSON.parse(await readFile(path.resolve(ROOT, SNAPSHOT), 'utf8'));
  const snap = normalizeSnapshot(raw);
  if (!snap) {
    console.error('[generate][fatal] 快照里找不到 tree / appId 字段');
    process.exit(1);
  }
  const appId = APP_ID ?? snap.appId;

  log(`目标 App: ${appId}`);
  log(`快照来源: ${SNAPSHOT}`);

  const pool = await loadSnapshotPool();
  log(`负样本池: ${pool.length} 个快照（来自 ${path.relative(ROOT, FIXTURE_DIR)}）`);

  // 构造上报对象。服务端的 detectLeak 需要原始树；
  // 这里直接复用服务端的漏跳判定，保证 CLI 与服务端行为一致。
  const { detectLeak } = await import('../../server/server.mjs');
  const leak = detectLeak(snap.tree);
  if (!leak.leak) {
    warn(`快照里没有可点击的跳过类节点（原因: ${leak.reason}），无法生成规则`);
    process.exit(1);
  }
  log(`检测到跳过候选 ${leak.candidates.length} 个`);

  const report = {
    appId,
    appName: raw.appName ?? raw.name ?? appId,
    activityId: snap.activityId,
    leakCandidates: leak.candidates,
    tree: snap.tree,
    snapshot: { tree: snap.tree, appId, expect: snap.expect ?? undefined },
  };

  const candidates = await callLLM(report, { dryRun: DRY_RUN });
  if (!candidates.length) {
    warn('模型未给出候选规则');
    process.exit(1);
  }
  log(`模型给出 ${candidates.length} 条候选`);

  // 逐条校验
  const results = [];
  let accepted = null;
  for (const c of candidates) {
    if (!c?.matches) continue;
    const v = validateRule(
      { appId, groupName: '开屏广告', rule: { matches: c.matches } },
      report.snapshot,
      pool,
      { scope: 'app', checkIdOwnership: true },
    );
    results.push({ matches: c.matches, note: c.note, pass: v.pass, reasons: v.reasons });
    const mark = v.pass ? '✓ 通过' : '✗ 拦截';
    log(`  ${mark}  ${c.matches}${c.note ? `  — ${c.note}` : ''}`);
    if (!v.pass) for (const r of v.reasons) warn(`      ${r}`);
    if (v.pass && !accepted) accepted = { c, v };
  }

  if (!accepted) {
    warn('所有候选均未通过校验，不落库');
    process.exit(1);
  }

  const ruleFile = {
    id: appId,
    name: report.appName,
    groups: [
      {
        key: 0,
        name: '开屏广告',
        rules: [
          {
            key: 0,
            matches: accepted.c.matches,
            actionMaximum: 1,
            matchTime: 10000,
            resetMatch: 'app',
            ...(report.activityId ? { activityIds: report.activityId } : {}),
          },
        ],
      },
    ],
  };

  const outFile = path.join(OUT_DIR, `${appId}.json5`);
  if (DRY_RUN) {
    log(`dry-run：未写入。将会写入 ${path.relative(ROOT, outFile)}`);
    log(JSON.stringify(ruleFile, null, 2));
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    outFile,
    `// 由 generate-rules.mjs 生成于 ${new Date().toISOString()}\n` +
      `// 选中候选: ${accepted.c.matches}\n${JSON.stringify(ruleFile, null, 2)}\n`,
    'utf8',
  );
  log(`已写入 ${path.relative(ROOT, outFile)}`);
  log('下一步: 运行 npm run aggregate 把这条规则收进订阅产物');
}

main().catch((e) => {
  console.error('[generate][fatal]', e);
  process.exit(1);
});
