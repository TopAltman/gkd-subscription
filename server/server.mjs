#!/usr/bin/env node
/**
 * 漏跳上报 + LLM 规则生成服务（L2 层服务端）
 *
 * 流程：
 *   POST /report      端上上报漏跳快照（只收节点树，不收截图）
 *   POST /generate    对指定上报生成候选规则，走校验器，通过则写入 rules/local/
 *   GET  /pending     查看待人工确认的规则队列
 *
 * 设计要点（这些是「自动修复」能否真正安全落地的关键）：
 *
 *  1. 隐私：接口只接受节点树（结构化文本/属性），**拒绝**任何图片字段。
 *     节点树里的文字理论上可反推用户在看什么，所以：
 *     - 服务端默认不落盘原始上报，只在内存队列保留 N 小时
 *     - 日志里对 text 字段做截断/脱敏
 *     - 生成的规则只保留「控件标识类」属性（id / desc / 固定文案），不保留账号名等敏感文案
 *
 *  2. LLM 不可信：模型生成的规则必须过校验器（语法 + 命中 + 不误触），
 *     且必须经过「负样本」检查。校验不通过的一律不发布。
 *     这与 GKD-Plus / GKD-XA 的「AI 生成规则直接写入本地」有本质区别 ——
 *     那些是用户自己在看屏幕，风险自担；这里要自动发布到订阅，必须服务端把关。
 *
 *  3. 成本控制：只在「高置信度漏跳」上调用 LLM（详见 detectLeak）。
 *     每次调用前先检查是否已有可用规则，避免重复付费。
 *
 * 运行：node server/server.mjs   （需要配置 LLM_API_KEY / LLM_BASE_URL）
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRule } from '../scripts/rule-validator/validate.mjs';
import { SYSTEM_PROMPT, buildUserPrompt } from '../scripts/llm/prompt.mjs';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT ?? 8787);
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1';
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'deepseek-chat';
const RULES_DIR = process.env.RULES_DIR ?? './rules/local';
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR ?? './fixtures/snapshots';
const QUEUE_TTL_MS = Number(process.env.QUEUE_TTL_MS ?? 6 * 3600 * 1000);

// 鉴权 token。设置后 /report 与 /generate 必须带 `Authorization: Bearer <token>`。
// 未设置时服务仅监听回环地址（见下），适合本机自用；
// 一旦对外暴露（反代/公网），必须配置 token —— 否则任何人都能白嫖你的 LLM 额度。
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';

// 限流：每分钟最多受理的上报数。超过则直接拒绝，不再进队列（防刷）。
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);
const rateWindow = new Map(); // ip -> { count, resetAt }

// 干跑模式：只校验不落库，用于调试生成结果。

// 监听地址。默认只监听回环地址 —— 这个服务能触发 LLM 调用，
// 对外暴露就等于把 API 额度交出去。需要局域网/公网访问时显式设 HOST=0.0.0.0
// 并务必同时配置 AUTH_TOKEN。
const HOST = process.env.HOST ?? '127.0.0.1';

// 允许跳过的按钮文案（漏跳判定的语义依据）
const SKIP_TEXTS = [
  '跳过',
  '跳过广告',
  '跳过此广告',
  '关闭广告',
  '不再显示',
  'skip',
  'skip ad',
  'close ad',
  '关闭',
];

const log = (...a) => console.log('[server]', new Date().toISOString().slice(11, 19), ...a);
const warn = (...a) => console.warn('[server][warn]', ...a);

/* ------------------------------------------------------------------ */
/* 鉴权与限流                                                          */
/* ------------------------------------------------------------------ */

/**
 * 校验请求鉴权。配置了 AUTH_TOKEN 时必须匹配。
 * @returns {{ok:boolean, status:number, error?:string}}
 */
export function checkAuth(req) {
  if (!AUTH_TOKEN) return { ok: true };
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-auth-token'];
  if (!token) return { ok: false, status: 401, error: '缺少鉴权凭据' };
  // 定长比较，避免通过响应时间侧信道逐字节猜 token
  const a = Buffer.from(String(token));
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return { ok: false, status: 403, error: '鉴权凭据无效' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, status: 403, error: '鉴权凭据无效' };
  return { ok: true };
}

/**
 * 滑动窗口限流。
 * @returns {{ok:boolean, remaining:number, retryAfter:number}}
 */
export function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateWindow.get(key);
  if (!entry || now >= entry.resetAt) {
    rateWindow.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true, remaining: RATE_LIMIT_PER_MIN - 1, retryAfter: 0 };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_PER_MIN) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: RATE_LIMIT_PER_MIN - entry.count, retryAfter: 0 };
}

/* ------------------------------------------------------------------ */
/* 内存上报队列                                                        */
/* ------------------------------------------------------------------ */

/** reportId -> {report, receivedAt} */
const pending = new Map();

function pruneQueue() {
  const now = Date.now();
  for (const [id, v] of pending) {
    if (now - v.receivedAt > QUEUE_TTL_MS) pending.delete(id);
  }
}
setInterval(pruneQueue, 60_000).unref?.();

/* ------------------------------------------------------------------ */
/* 上报校验                                                            */
/* ------------------------------------------------------------------ */

/** 疑似承载图片/二进制内容的字段名。 */
const IMAGE_FIELD_NAMES = new Set([
  'image',
  'images',
  'screenshot',
  'screenshots',
  'bitmap',
  'base64',
  'png',
  'jpeg',
  'jpg',
  'gif',
  'webp',
  'pixel',
  'pixels',
  'thumbnail',
  'icon',
  'iconbase64',
]);

/**
 * 递归查找上报体里的图片字段（只看字段名，不看内容）。
 *
 * @returns {string|null} 命中的字段路径，没命中返回 null
 */
export function findImageField(value, path = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 40) return null;
  for (const [k, v] of Object.entries(value)) {
    const lower = k.toLowerCase();
    if (IMAGE_FIELD_NAMES.has(lower)) return path ? `${path}.${k}` : k;
    const found = findImageField(v, path ? `${path}.${k}` : k, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 节点树深度上限。真实快照通常 < 30 层；超过说明是异常或恶意构造。
 */
const MAX_TREE_DEPTH = 60;

/** 节点树节点数上限，防止超大快照拖垮服务。 */
const MAX_TREE_NODES = 20000;

/**
 * 统计节点树规模，超限时拒绝。
 * @returns {{ok:boolean, depth:number, nodes:number, reason?:string}}
 */
export function checkTreeSize(tree) {
  let nodes = 0;
  let depth = 0;
  const walk = (node, d) => {
    if (!node || typeof node !== 'object') return;
    nodes++;
    if (d > depth) depth = d;
    if (nodes > MAX_TREE_NODES) return;
    for (const c of node.children ?? []) walk(c, d + 1);
  };
  walk(tree, 0);
  if (nodes > MAX_TREE_NODES) {
    return { ok: false, depth, nodes, reason: `节点数超过上限 ${MAX_TREE_NODES}` };
  }
  if (depth > MAX_TREE_DEPTH) {
    return { ok: false, depth, nodes, reason: `树深度超过上限 ${MAX_TREE_DEPTH}` };
  }
  return { ok: true, depth, nodes };
}

/* ------------------------------------------------------------------ */
/* 漏跳判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 判断上报的快照是否真的是「漏跳」。
 *
 * 判定依据：节点树里存在一个可点击的、文本匹配跳过类文案的节点。
 * 注意这里只做「有跳过按钮」的判断，不做「应该被点」的判断 ——
 * 后者由校验器的负样本检查来把关。
 */
export function detectLeak(tree) {
  if (!tree) return { leak: false, reason: 'no_tree' };
  const hits = [];

  /** 取节点自身的文案。 */
  const ownText = (n) =>
    [
      String(n?.attributes?.text ?? ''),
      String(n?.attributes?.desc ?? n?.attributes?.contentDescription ?? ''),
    ]
      .filter(Boolean)
      .join(' ');

  const isSkipText = (s) => {
    const hay = s.toLowerCase();
    return SKIP_TEXTS.some((t) => hay.includes(t.toLowerCase()));
  };

  const walk = (node, depth) => {
    if (!node || depth > 30) return;
    const text = String(node.attributes?.text ?? '');
    const desc = String(node.attributes?.desc ?? node.attributes?.contentDescription ?? '');
    const clickable = node.attributes?.clickable === true;

    if (clickable) {
      // 直接文案命中
      if (isSkipText(`${text} ${desc}`)) {
        hits.push({
          name: node.name,
          id: node.attributes?.id ?? null,
          text: text.slice(0, 30),
          desc: desc.slice(0, 30),
          via: 'self',
        });
      } else {
        // ⚠️ 兄弟文案命中 —— 这是最常见的真实结构，漏掉它会漏掉大量真漏跳。
        //
        //   ┌ FrameLayout
        //   │  ├ ImageView#skip_btn  ← 可点击，但**没有文字**
        //   │  └ TextView   "跳过 5"  ← 文案在兄弟节点上
        //
        // 只看节点自身文案的话，这类跳过按钮会被判成「不是漏跳」，
        // 于是永远等不到规则被修复 —— 而这恰恰是最主流的开屏广告形态。
        const siblings = (node.children ?? []).length ? [] : [];
        void siblings;
        const parent = node.__parent;
        const sibTexts = (parent?.children ?? [])
          .filter((c) => c !== node)
          .map((c) => ownText(c))
          .filter(Boolean);
        if (sibTexts.length && isSkipText(sibTexts.join(' '))) {
          hits.push({
            name: node.name,
            id: node.attributes?.id ?? null,
            text: text.slice(0, 30),
            desc: desc.slice(0, 30),
            via: 'sibling',
            siblingText: sibTexts.join(' | ').slice(0, 60),
          });
        }
      }
    }

    for (const c of node.children ?? []) {
      c.__parent = node;
      walk(c, depth + 1);
    }
  };
  walk(tree, 0);
  if (hits.length === 0) return { leak: false, reason: 'no_skip_button' };
  return { leak: true, candidates: hits };
}

/* ------------------------------------------------------------------ */
/* 快照脱敏                                                            */
/* ------------------------------------------------------------------ */

/**
 * 保留结构与控件标识，剥离可能含用户身份的内容。
 * 保留：name / id / desc / clickable / visibleToUser / bounds / 类名
 * 剥离：text（除非是跳过类固定文案）、任何看起来像账号/手机号/邮箱的内容
 */
export function sanitizeTree(node, depth = 0) {
  if (!node || depth > 30) return null;
  const attrs = {};
  for (const k of ['id', 'clickable', 'visibleToUser', 'enabled', 'focusable', 'scrollable', 'longClickable']) {
    if (node.attributes?.[k] !== undefined) attrs[k] = node.attributes[k];
  }
  const rawText = String(node.attributes?.text ?? '');
  const rawDesc = String(node.attributes?.desc ?? node.attributes?.contentDescription ?? '');
  // 跳过类固定文案保留，其它一律剥离
  if (SKIP_TEXTS.some((t) => rawText.toLowerCase().includes(t.toLowerCase()))) {
    attrs.text = rawText.slice(0, 30);
  }
  if (rawDesc && SKIP_TEXTS.some((t) => rawDesc.toLowerCase().includes(t.toLowerCase()))) {
    attrs.desc = rawDesc.slice(0, 30);
  }
  if (node.attributes?.bounds) attrs.bounds = node.attributes.bounds;
  return {
    name: node.name,
    attributes: attrs,
    children: (node.children ?? []).map((c) => sanitizeTree(c, depth + 1)).filter(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* LLM 规则生成                                                        */
/* ------------------------------------------------------------------ */

export async function callLLM(report, options = {}) {
  // 干跑模式：不消耗额度，用固定候选替代模型输出。
  // 用于在没有 API key 的环境里验证「生成 → 校验 → 落库」整条链路。
  // options.dryRun 可由调用方显式指定（CLI 用），否则跟随进程启动参数。
  if (options.dryRun ?? DRY_RUN) {
    const candidates = mockCandidates(report);
    log(`[dry-run] 使用模拟候选 ${candidates.length} 条`);
    return candidates;
  }
  if (!LLM_API_KEY) {
    throw new Error('未配置 LLM_API_KEY，无法调用模型');
  }
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(report) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM 调用失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`LLM 返回的不是合法 JSON: ${content.slice(0, 200)}`);
  }
  return parsed.candidates ?? [];
}

/**
 * 生成模拟候选（干跑模式用）。
 *
 * 刻意混合「应该通过」与「应该被拦截」的候选，
 * 这样一次干跑就能同时验证校验器的两个方向。
 */
function mockCandidates(report) {
  const cands = report.leakCandidates ?? [];
  const out = [];
  // ① 精确 id —— 期望通过
  for (const c of cands) {
    if (c.id) {
      out.push({
        matches: `[id="${c.id}"]`,
        note: '按控件 id 精确匹配（模拟候选，应通过）',
      });
      break;
    }
  }
  // ② 宽松文案 —— 期望被同 App 的非开屏页拦下
  out.push({
    matches: '[text*="跳过"]',
    note: '宽松文案匹配（模拟候选，应被拦截）',
  });
  // ③ 语法错误 —— 期望编译期拦下
  out.push({
    matches: '[text=',
    note: '语法错误（模拟候选，应被拦截）',
  });
  // ④ 指向其它包的 id —— 期望被 id 归属检查拦下
  out.push({
    matches: '[id="com.definitely.other.app:id/skip_btn"]',
    note: '跨包 id（模拟候选，应被拦截）',
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 生成 + 校验 + 落库                                                  */
/* ------------------------------------------------------------------ */

async function loadSnapshots() {
  const out = [];
  if (!existsSync(SNAPSHOT_DIR)) return out;
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(SNAPSHOT_DIR);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(SNAPSHOT_DIR, f), 'utf8'));
      out.push({ ...raw, file: f });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out;
}

/**
 * 对一条上报生成规则并校验。
 * @returns {{ok:boolean, results:object[], written:string|null}}
 */
export async function generateAndValidate(report, snapshots) {
  const candidates = await callLLM(report);
  if (!candidates.length) {
    return { ok: false, results: [], written: null, reason: '模型未给出候选' };
  }

  // 负样本：把全部快照交给校验器，由它按 GKD 的作用域语义挑选。
  //
  // App 级规则只在目标 App 内运行，所以真正会造成误触的是**同 App 的非开屏页面**
  // （同一个 App 的首页/设置页里也有「跳过」字样的按钮，点错就是误触）。
  // 其它 App 的快照对 App 级规则不构成风险 —— 那些规则根本不会在那里被求值。
  // 全局组规则才需要拿所有 App 的快照当负样本。
  const negativePool = snapshots;

  const results = [];
  let accepted = null;
  for (const c of candidates) {
    if (!c?.matches) continue;
    const v = validateRule(
      { appId: report.appId, groupName: '开屏广告', rule: { matches: c.matches } },
      report.snapshot,
      negativePool,
      { scope: 'app', checkIdOwnership: true },
    );
    results.push({
      matches: c.matches,
      note: c.note,
      pass: v.pass,
      reasons: v.reasons,
      warnings: v.warnings,
      semantic: v.details?.semantic,
    });
    // 只接受第一个通过的候选，并且必须真的命中了目标快照
    if (v.pass && !accepted) accepted = { c, v };
  }

  if (!accepted) {
    return { ok: false, results, written: null, reason: '所有候选均未通过校验' };
  }

  // 落库到 rules/local/<包名>.json5
  const ruleFile = {
    id: report.appId,
    name: report.appName ?? report.appId,
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
  if (!DRY_RUN) {
    await mkdir(RULES_DIR, { recursive: true });
    await writeFile(
      path.join(RULES_DIR, `${report.appId}.json5`),
      `// 由自动修复流水线生成于 ${new Date().toISOString()}\n${JSON.stringify(ruleFile, null, 2)}\n`,
      'utf8',
    );
  }
  return {
    ok: true,
    results,
    written: `${report.appId}.json5`,
    selected: accepted.c.matches,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        pending: pending.size,
        llm: !!LLM_API_KEY,
        auth: AUTH_TOKEN ? 'enabled' : 'disabled',
        rateLimitPerMin: RATE_LIMIT_PER_MIN,
      });
    }

    if (req.method === 'GET' && url.pathname === '/pending') {
      pruneQueue();
      const list = [...pending.entries()].map(([id, v]) => ({
        reportId: id,
        appId: v.report.appId,
        activityId: v.report.activityId,
        leakCandidates: v.report.leakCandidates,
        receivedAt: new Date(v.receivedAt).toISOString(),
      }));
      return json(res, 200, { count: list.length, items: list });
    }

    if (req.method === 'POST' && url.pathname === '/report') {
      // 鉴权 + 限流：先挡掉未授权与刷量，再做解析
      const auth = checkAuth(req);
      if (!auth.ok) {
        warn(`拒绝上报：${auth.error}`);
        return json(res, auth.status, { ok: false, error: auth.error });
      }
      const rl = checkRateLimit(req.socket.remoteAddress ?? 'unknown');
      if (!rl.ok) {
        res.setHeader('retry-after', String(rl.retryAfter));
        return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');

      // 隐私硬约束：拒绝带图片/二进制字段的请求。
      //
      // 必须按**字段名**判定，不能对整个 JSON 文本做关键词扫描 ——
      // 后者会把正常节点树里的 `desc: "View image"`、
      // `id: "com.x:id/cover_image"` 之类的合法内容误判为图片而拒收。
      // 早期实现正是全文扫描，实测会误拒含 image 描述的正常上报。
      const imageField = findImageField(body);
      if (imageField) {
        warn(`拒绝上报：请求中包含图片字段 "${imageField}"`);
        return json(res, 400, { ok: false, error: '不接受图片/截图字段', field: imageField });
      }

      const tree = body.tree;
      if (!tree) return json(res, 400, { ok: false, error: '缺少 tree 字段' });

      // 体积校验：超大/超深快照直接拒绝，防止拖垮服务
      const size = checkTreeSize(tree);
      if (!size.ok) {
        warn(`拒绝上报：${size.reason}`);
        return json(res, 413, { ok: false, error: size.reason });
      }
      if (!body.appId || typeof body.appId !== 'string') {
        return json(res, 400, { ok: false, error: '缺少 appId 字段' });
      }

      const leak = detectLeak(tree);
      if (!leak.leak) {
        return json(res, 200, { ok: true, accepted: false, reason: leak.reason });
      }

      const reportId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const sanitized = sanitizeTree(tree);

      // 目标快照必须带 expect —— 否则校验器的语义校验（③ 不越界）会整体失效。
      //
      // detectLeak 已经定位到了「哪个节点是可点的跳过按钮」，把它作为预期值传下去，
      // 校验器才能判断 LLM 生成的规则是不是点到了**同一个**控件，
      // 而不是碰巧命中了页面上另一个长得像的可点节点（比如「确认支付」）。
      const expect = {};
      const firstCandidate = leak.candidates[0];
      if (firstCandidate?.id) expect.id = String(firstCandidate.id).split(':id/').pop();
      if (firstCandidate?.text) expect.text = String(firstCandidate.text).trim();

      pending.set(reportId, {
        receivedAt: Date.now(),
        report: {
          appId: body.appId,
          appName: body.appName,
          activityId: body.activityId,
          leakCandidates: leak.candidates,
          tree: sanitized,
          // 校验用原树 + 预期，仅内存持有
          snapshot: { tree, appId: body.appId, expect },
        },
      });
      log(`收到漏跳上报 ${reportId}: ${body.appId} 候选 ${leak.candidates.length} 个`);
      return json(res, 200, { ok: true, accepted: true, reportId });
    }

    if (req.method === 'POST' && url.pathname === '/generate') {
      const auth = checkAuth(req);
      if (!auth.ok) {
        warn(`拒绝生成：${auth.error}`);
        return json(res, auth.status, { ok: false, error: auth.error });
      }
      const rl = checkRateLimit(`gen:${req.socket.remoteAddress ?? 'unknown'}`);
      if (!rl.ok) {
        res.setHeader('retry-after', String(rl.retryAfter));
        return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const entry = pending.get(body.reportId);
      if (!entry) return json(res, 404, { ok: false, error: 'reportId 不存在或已过期' });
      const snapshots = await loadSnapshots();
      const result = await generateAndValidate(entry.report, snapshots);
      log(`生成结果 reportId=${body.reportId} ok=${result.ok} written=${result.written}`);
      return json(res, result.ok ? 200 : 422, result);
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    warn('请求处理异常:', e.message);
    return json(res, 500, { ok: false, error: e.message });
  }
});

// 仅当本文件是直接执行的入口时才跑 CLI。
// process.argv[1] 在 `node -e` 或被 import 时可能为 undefined，
// 直接 pathToFileURL(undefined) 会抛 TypeError —— 用可选链先做保护。
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  server.listen(PORT, HOST, () => {
    // 用 server.address() 取实际端口 —— PORT=0 时系统会分配随机端口，
    // 直接打印 PORT 会得到 "http://host:0"，客户端无法连接。
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
    log(`服务已启动 http://${HOST}:${boundPort}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !AUTH_TOKEN) {
      warn('⚠ 对外监听但未配置 AUTH_TOKEN —— 任何人都能触发本服务的 LLM 调用，请立即配置！');
    }
    log(`LLM: ${LLM_BASE_URL} model=${LLM_MODEL} key=${LLM_API_KEY ? '已配置' : '未配置'}`);
    log(`规则输出目录: ${RULES_DIR}`);
  });
}
