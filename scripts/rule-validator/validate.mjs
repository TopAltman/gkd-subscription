#!/usr/bin/env node
/**
 * 规则校验器（L2 层的安全闸门）
 *
 * 这是整条流水线里最重要的一环。LLM 生成的规则在语法上合法 ≠ 安全。
 * 必须验证三件事：
 *   ① 命中：在目标快照上能选中预期节点（不漏跳）
 *   ② 不误触：在**同一个 App** 的非开屏快照上不命中（误触比漏跳危险得多 —— 点错"确认支付"的代价远大于多看 3 秒广告）
 *   ③ 不越界：命中节点的语义（id / 文案）与预期一致，不能点到"确认支付"上去
 *
 * ## 关于「负样本的作用域」——这是本实现最容易搞错的地方
 *
 * GKD 的 App 级规则是**按包名严格作用域**执行的：
 *   上游 `AppRule.matchActivity()` 里 `if (appId != app.id) return false`
 *   也就是说，com.foo 的规则**根本不会**在 com.bar 里被求值。
 *
 * 所以：
 *   - **跨 App 的快照不是 App 级规则的误触风险**。规则在别的 App 里压根不会运行。
 *     拿别的 App 的快照去卡它，是把「不存在的问题」当成「安全校验」，白白拒掉大量可用规则。
 *   - **真正的误触风险在同一个 App 内部**：这个 App 的首页、设置页、播放器页
 *     也可能有个叫「跳过」的按钮，点错了就是误触。必须用**同 App 的非开屏快照**去卡。
 *   - **全局组（globalGroups）才是例外**：它们对所有 App 生效，
 *     所以对全局规则必须用**全部 App 的快照**做负样本。
 *
 * 早期版本把所有快照一股脑当负样本，既漏掉了同 App 内的真实风险，
 * 又用不存在的风险拒掉了大量正确规则 —— 两个方向都错。
 *
 * 技术可行性已实测验证：
 *   @gkd-kit/selector 是 GKD 官方发布的 npm 包（GPL-3.0），内含完整的 Kotlin/JS 选择器
 *   解析与匹配引擎，可脱离 Android 在纯 Node.js 中运行。适配器契约见 JsNodeAdapter：
 *   getAttr / getName / getChildCount / getChild / getParent / getNodeKey 六个方法。
 *   匹配入口 adapter.querySelector(rootNode, selector, MatchOptions.default)。
 *   注意：Selector.compile 返回 SelectorCompileResult.Success / .Failure 两个子类，
 *   判断成功要用 instanceof，不是读 .success 字段（Kotlin/JS 会把属性名混淆）。
 *
 * 用法：
 *   node ./scripts/rule-validator/validate.mjs --rules rules/local/xxx.json5
 *   node ./scripts/rule-validator/validate.mjs --all
 *   node ./scripts/rule-validator/validate.mjs --subscription dist/gkd.json5
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';
import { Selector, SelectorCompileResult, JsNodeAdapter, MatchOptions } from '@gkd-kit/selector';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const log = (...a) => console.log('[validate]', ...a);
const warn = (...a) => console.warn('[validate][warn]', ...a);

/* ------------------------------------------------------------------ */
/* 节点树 → 适配器                                                     */
/* ------------------------------------------------------------------ */

/**
 * 把 GKD 的 MatchSimulatedNode 结构（name + attributes + children）转成可匹配的扁平索引。
 * 与 GKD 源码 SimulatedNodeAdapter 保持一致的属性语义。
 */
export class ReplayAdapter extends JsNodeAdapter {
  constructor(tree) {
    super();
    this.nodes = [];
    this.parentOf = new Map();
    this.indexOf = new Map();
    this.#flatten(tree, null);
  }

  #flatten(node, parent) {
    const i = this.nodes.length;
    this.nodes.push(node);
    this.parentOf.set(i, parent);
    this.indexOf.set(node, i);
    for (const c of node.children ?? []) this.#flatten(c, i);
  }

  getAttr(target, name) {
    const n = this.nodes[target];
    if (!n) return null;
    switch (name) {
      case 'name':
        return n.name;
      case 'childCount':
        return (n.children ?? []).length;
      case 'index': {
        const p = this.parentOf.get(target);
        if (p === null || p === undefined) return 0;
        return (this.nodes[p].children ?? []).indexOf(n);
      }
      case 'parent': {
        const p = this.parentOf.get(target);
        return p === null || p === undefined ? null : p;
      }
      case 'depth': {
        let d = 0;
        let c = target;
        while (this.parentOf.get(c) !== null && this.parentOf.get(c) !== undefined) {
          d++;
          c = this.parentOf.get(c);
        }
        return d;
      }
      default: {
        const v = n.attributes?.[name];
        return v === undefined || v === null ? null : v;
      }
    }
  }

  getName(node) {
    return this.nodes[node]?.name ?? null;
  }

  getChildCount(node) {
    return (this.nodes[node]?.children ?? []).length;
  }
  getChild(node, i) {
    const c = (this.nodes[node]?.children ?? [])[i];
    return c === undefined ? null : this.indexOf.get(c);
  }
  getParent(node) {
    const p = this.parentOf.get(node);
    return p === null || p === undefined ? null : p;
  }
  getNodeKey(node) {
    return node;
  }
}

/* ------------------------------------------------------------------ */
/* 编译与匹配                                                          */
/* ------------------------------------------------------------------ */

/** 编译选择器。返回 {ok, selector} 或 {ok:false, message}。 */
export function compileSelector(source) {
  const r = Selector.compile(source);
  if (r instanceof SelectorCompileResult.Failure) {
    return { ok: false, message: r.message ?? '未知语法错误' };
  }
  return { ok: true, selector: r.value };
}

/** 在快照上执行一条选择器，返回命中节点的可读描述（未命中返回 null）。 */
export function matchOnSnapshot(tree, selectorSource) {
  const c = compileSelector(selectorSource);
  if (!c.ok) return { status: 'compile_error', message: c.message };
  const adapter = new ReplayAdapter(tree);
  const hit = adapter.querySelector(0, c.selector, MatchOptions.default);
  if (hit === null || hit === undefined) return { status: 'no_match' };
  const node = adapter.nodes[hit];
  return {
    status: 'matched',
    nodeIndex: hit,
    name: node?.name,
    attrs: node?.attributes ?? {},
    path: describePath(adapter, hit),
  };
}

function describePath(adapter, idx) {
  const parts = [];
  let cur = idx;
  let guard = 0;
  while (cur !== null && cur !== undefined && guard++ < 64) {
    const n = adapter.nodes[cur];
    const id = n?.attributes?.id;
    const text = n?.attributes?.text;
    parts.unshift(id ? `${n.name}#${id}` : text ? `${n.name}"${text}"` : n?.name ?? '?');
    cur = adapter.getParent(cur);
  }
  return parts.join(' > ');
}

/**
 * 收集命中节点自身及其整棵子树的 text / desc，用于语义校验。
 */
function collectTexts(adapter, idx) {
  const out = [];
  const visit = (i, depth) => {
    if (i === null || i === undefined || depth > 8) return;
    const n = adapter.nodes[i];
    if (!n) return;
    if (n.attributes?.text) out.push(n.attributes.text);
    if (n.attributes?.desc) out.push(n.attributes.desc);
    if (n.attributes?.contentDescription) out.push(n.attributes.contentDescription);
    for (const c of n.children ?? []) {
      const ci = adapter.indexOf.get(c);
      if (ci !== undefined) visit(ci, depth + 1);
    }
  };
  visit(idx, 0);
  return out;
}

/**
 * 收集命中节点的**兄弟节点**与父节点的文案。
 *
 * 为什么需要这个：现实里的跳过按钮极常是一个「无文字的 ImageView」，
 * 而「跳过」两个字在它**旁边的 TextView** 上。经典结构长这样：
 *
 *   ┌ FrameLayout
 *   │  ├ ImageView#skip_btn   ← 选择器命中的是这个（没文字）
 *   │  └ TextView  "跳过 5"   ← 文案在兄弟节点上
 *
 * 如果只看命中节点自己的子树，任何针对 ImageView 的精确规则都会被
 * 误判成「点错控件」而拒掉 —— 这会把最可靠的一批规则全部误杀。
 */
function collectContextTexts(adapter, idx) {
  const out = [];
  const parent = adapter.getParent(idx);
  if (parent === null || parent === undefined) return out;
  const p = adapter.nodes[parent];
  for (const c of p?.children ?? []) {
    const ci = adapter.indexOf.get(c);
    if (ci === undefined) continue;
    const n = adapter.nodes[ci];
    if (n?.attributes?.text) out.push(n.attributes.text);
    if (n?.attributes?.desc) out.push(n.attributes.desc);
    if (n?.attributes?.contentDescription) out.push(n.attributes.contentDescription);
  }
  return out;
}

/** 复用同一个 adapter 实例，避免重复建索引。 */
function adapterOf(tree) {
  if (!tree.__adapter) {
    const a = new ReplayAdapter(tree);
    Object.defineProperty(tree, '__adapter', { value: a, enumerable: false });
  }
  return tree.__adapter;
}

/* ------------------------------------------------------------------ */
/* id 归属检查                                                         */
/* ------------------------------------------------------------------ */

/**
 * 提取选择器里硬编码的 id 所归属的包名。
 *
 * GKD 的 id 形如 `com.foo:id/skip_btn`，冒号前是包名。
 * 对 **LLM 自动生成的规则**，如果它指向的 id 属于另一个包，
 * 说明模型把别的 App 的控件抄进来了 —— 这条规则在本 App 里必然匹配不到，
 * 属于典型幻觉，必须拦下。
 *
 * 对**社区源的人工规则**则不能一刀切：有些 App 内嵌了 SDK
 * （如宿主 App 内嵌穿山甲广告 SDK com.byted.pangle:id/tt_item_tv），
 * 控件 id 本来就属于另一个包。实测这类占比 1.54%，所以只对自动生成的规则启用该检查。
 *
 * @param {string[]} selectorSources
 * @returns {string[]} 出现过的包名（去重）
 */
export function extractIdPackages(selectorSources) {
  const pkgs = new Set();
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  for (const src of selectorSources) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const raw = m[1];
      const pkg = raw.includes(':id/') ? raw.slice(0, raw.indexOf(':id/')) : raw;
      // 只有像包名的才检查（含至少一个点，且不是 android/ 系统包）
      if (pkg.includes('.') && !pkg.startsWith('android.')) pkgs.add(pkg);
    }
  }
  return [...pkgs];
}

/* ------------------------------------------------------------------ */
/* 校验主流程                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按作用域挑选负样本。
 *
 * @param {object}   rule        { appId, groupName, rule: {matches, ...} }
 * @param {'app'|'global'} scope  app 级规则 vs 全局组规则
 * @param {object[]} snapshots   全部可用快照
 * @returns {{sameApp:object[], crossApp:object[]}}
 */
export function selectNegatives(rule, scope, snapshots) {
  const negatives = (snapshots ?? []).filter((s) => s.kind !== 'positive');
  if (scope === 'global') {
    // 全局组对所有 App 生效 → 全部非正样本都是负样本
    return { sameApp: negatives, crossApp: [] };
  }
  // App 级规则：只有同 App 的非开屏页面才可能误触
  const sameApp = negatives.filter((s) => s.appId === rule.appId);
  const crossApp = negatives.filter((s) => s.appId !== rule.appId);
  return { sameApp, crossApp };
}

/**
 * 校验一条待发布规则。
 *
 * @param {object}  rule        { appId, groupName, rule: {matches, ...} }
 * @param {object}  targetSnap  目标快照 { tree, expect? }
 * @param {object[]} snapshots  全部可用快照（正/负混合），用于挑选负样本
 * @param {object}  [options]
 * @param {'app'|'global'} [options.scope='app']  规则作用域
 * @param {boolean} [options.strictCrossApp=false] 是否把跨 App 命中也算误触（默认否）
 * @param {boolean} [options.checkIdOwnership=false] 是否检查 id 包名归属
 * @returns {{pass:boolean, reasons:string[], warnings:string[], details:object}}
 */
export function validateRule(rule, targetSnap, snapshots = [], options = {}) {
  const { scope = 'app', strictCrossApp = false, checkIdOwnership = false } = options;

  const reasons = [];
  const warnings = [];
  const details = {};

  // matches 既可能是单个字符串，也可能是字符串数组（GKD 的 RawRuleProps.matches: List<String>?）。
  // 数组形式表示「命中任意一个即可」，每个元素是独立的选择器，必须逐个编译与验证。
  const raw = rule.rule?.matches;
  const selectorList = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
  if (selectorList.length === 0) {
    return { pass: false, reasons: ['规则缺少 matches 字段'], warnings, details };
  }

  // ① 语法：每个选择器都要能编译
  const compiled = [];
  for (const src of selectorList) {
    const c = compileSelector(src);
    if (!c.ok) {
      reasons.push(`选择器语法错误: ${src} -> ${c.message}`);
    } else {
      compiled.push({ src, selector: c.selector });
    }
  }
  if (reasons.length > 0) return { pass: false, reasons, warnings, details };
  details.selectors = selectorList;

  // ② 目标快照必须命中（任一选择器命中即可）
  if (targetSnap?.tree) {
    const adapter = adapterOf(targetSnap.tree);
    let hit = null;
    let hitSrc = null;
    for (const { src, selector } of compiled) {
      const m = adapter.querySelector(0, selector, MatchOptions.default);
      if (m !== null && m !== undefined) {
        hit = m;
        hitSrc = src;
        break;
      }
    }
    if (hit === null) {
      reasons.push('在目标快照上未命中（规则无效）');
    } else {
      const node = adapter.nodes[hit];
      const attrs = node?.attributes ?? {};
      // 命中后还要确认「点的是不是预期那个控件」。
      // 现实里跳过按钮常常是 ImageView / 无文字节点，文字写在 desc 或兄弟节点上。
      // 因此语义校验采用「任一信号成立即通过」：
      //   - id 命中（强信号：控件唯一标识）
      //   - text/desc 在命中节点自身或子树中出现（强信号：语义正确）
      const expect = targetSnap.expect ?? {};
      const expectText = expect.text ?? targetSnap.expectText;
      const expectId = expect.id ?? targetSnap.expectId;
      const idOk = expectId ? String(attrs.id ?? '').includes(expectId) : null;
      const texts = collectTexts(adapter, hit);
      // 兄弟/父节点上的文案也作为语义信号（跳过按钮常是无字 ImageView + 旁边有字 TextView）
      const contextTexts = collectContextTexts(adapter, hit);
      const textOk = expectText
        ? [...texts, ...contextTexts].some((t) => String(t).includes(expectText))
        : null;
      details.semantic = { idOk, textOk, texts, contextTexts, matchedBy: hitSrc };
      const anySignal = [idOk, textOk].filter((v) => v !== null);
      if (anySignal.length > 0 && !anySignal.some(Boolean)) {
        reasons.push(
          `命中节点 id="${attrs.id ?? ''}" 文本=[${texts.join('|') || '空'}] ` +
            `上下文=[${contextTexts.join('|') || '空'}]，` +
            `与预期 (id:${expectId ?? '-'} text:${expectText ?? '-'}) 均不符（可能点错控件）`,
        );
      }
    }
  } else {
    reasons.push('缺少目标快照，无法验证命中');
  }

  // ③ 负样本：按作用域挑选后不得命中
  const { sameApp, crossApp } = selectNegatives(rule, scope, snapshots);
  const check = (pool) => {
    const hits = [];
    for (const snap of pool) {
      if (!snap?.tree) continue;
      const adapter = adapterOf(snap.tree);
      for (const { src, selector } of compiled) {
        const m = adapter.querySelector(0, selector, MatchOptions.default);
        if (m !== null && m !== undefined) {
          hits.push({ appId: snap.appId ?? 'unknown', file: snap.file, selector: src });
          break;
        }
      }
    }
    return hits;
  };

  const sameAppHits = check(sameApp);
  details.sameAppFalsePositives = sameAppHits;
  if (sameAppHits.length > 0) {
    const where = scope === 'global' ? '负样本' : '同一 App 的非开屏界面';
    reasons.push(
      `在${where}上误命中 ${sameAppHits.length} 处：` +
        [...new Set(sameAppHits.map((f) => f.file ?? f.appId))].join(', '),
    );
  }

  // 跨 App 命中：App 级规则不会在别的 App 运行，仅作提示；
  // 全局规则或显式开启 strictCrossApp 时才算误触。
  const crossAppHits = check(crossApp);
  details.crossAppFalsePositives = crossAppHits;
  if (crossAppHits.length > 0) {
    if (scope === 'global' || strictCrossApp) {
      reasons.push(
        `在 ${crossAppHits.length} 个其它 App 的快照上误命中：` +
          [...new Set(crossAppHits.map((f) => f.appId))].join(', '),
      );
    } else {
      warnings.push(
        `在 ${crossAppHits.length} 个其它 App 的快照上也会命中` +
          `（App 级规则不会在那里运行，仅作提示；若将来要放进全局组则必须收紧）`,
      );
    }
  }

  // ④ id 归属：自动生成的规则若指向别的包的 id，多半是模型幻觉
  if (checkIdOwnership && rule.appId) {
    const pkgs = extractIdPackages(selectorList);
    const foreign = pkgs.filter((p) => p !== rule.appId);
    details.idPackages = pkgs;
    if (foreign.length > 0) {
      reasons.push(
        `选择器硬编码了其它包的控件 id（${foreign.join(', ')}），` +
          `与目标 App（${rule.appId}）不符，本 App 内不可能命中`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons, warnings, details };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function loadSnapshots(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const files = await readdir(dir);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      out.push({
        file: f,
        appId: raw.appId,
        activityId: raw.activityId,
        expect: raw.expect ?? null,
        expectText: raw.expectText,
        expectId: raw.expectId,
        tree: raw.tree,
        kind: raw.kind ?? 'unknown',
      });
    } catch (e) {
      warn(`快照 ${f} 解析失败: ${e.message}`);
    }
  }
  return out;
}

/**
 * 订阅文件模式：校验整份订阅的结构自洽性。
 *
 * 这与「校验自建规则」是两件不同的事：
 *   - 自建规则（rules/local/）：要拿快照做命中/误触验证 —— 它们是自己生成的，必须证明安全。
 *   - 社区聚合产物（dist/）：来源是社区人工维护的规则，7000+ 条 App 绝大多数没有对应快照，
 *     用快照去卡它们没有意义（必然大面积「缺少目标快照」）。
 *     这里改为检查**结构自洽性**：id 归属、key 唯一性、key 引用完整性、选择器语法、组结构。
 */
export function validateSubscriptionStructure(parsed) {
  const problems = [];
  const stats = { apps: 0, groups: 0, rules: 0, selectors: 0, globalGroups: 0 };

  const checkGroup = (appId, group, isGlobal) => {
    const where = isGlobal ? `globalGroup/${group.name}` : `${appId}/${group.name}`;
    const rules = group.rules ?? [];
    if (!Array.isArray(rules)) {
      problems.push(`${where}: rules 必须是数组`);
      return;
    }
    // key 唯一性
    const keys = rules.map((r) => r.key).filter((k) => k !== undefined && k !== null);
    if (new Set(keys).size !== keys.length) {
      problems.push(`${where}: 存在重复的 rule key（preKeys/actionCdKey 引用会错位）`);
    }
    // key 引用完整性
    const keySet = new Set(keys);
    for (const r of rules) {
      for (const k of ['actionCdKey', 'actionMaximumKey']) {
        if (r[k] !== undefined && r[k] !== null && !keySet.has(r[k])) {
          problems.push(`${where}: rule 的 ${k}=${r[k]} 指向了不存在的 key`);
        }
      }
      const preKeys = Array.isArray(r.preKeys) ? r.preKeys : [];
      for (const pk of preKeys) {
        if (!keySet.has(pk)) problems.push(`${where}: rule 的 preKeys 含不存在的 key=${pk}`);
      }
    }
    // 选择器语法
    for (const r of rules) {
      for (const src of [].concat(
        r.matches ?? [],
        r.anyMatches ?? [],
        r.excludeMatches ?? [],
        r.excludeAllMatches ?? [],
      )) {
        if (typeof src !== 'string' || !src.length) continue;
        stats.selectors++;
        const c = compileSelector(src);
        if (!c.ok) {
          problems.push(`${where}: 选择器语法错误 -> ${c.message} :: ${String(src).slice(0, 80)}`);
        }
      }
    }
    stats.rules += rules.length;
  };

  for (const g of parsed.globalGroups ?? []) {
    stats.globalGroups++;
    checkGroup('(global)', g, true);
  }
  for (const app of parsed.apps ?? []) {
    stats.apps++;
    if (!app.id) {
      problems.push('存在缺少 id 的 app 条目');
      continue;
    }
    for (const group of app.groups ?? []) {
      stats.groups++;
      checkGroup(app.id, group, false);
    }
  }

  // 顶层字段
  if (parsed.id === undefined || parsed.id === null) problems.push('订阅缺少 id');
  if (typeof parsed.version !== 'number') problems.push('订阅缺少数字类型的 version');

  return { problems, stats };
}

async function main() {
  const fixtureDir = getArg('fixtures', 'fixtures/snapshots');
  const snapshots = await loadSnapshots(fixtureDir);
  log(`已加载快照 ${snapshots.length} 个（来自 ${fixtureDir}）`);

  const positives = snapshots.filter((s) => s.kind === 'positive');
  const negatives = snapshots.filter((s) => s.kind !== 'positive');
  log(`正样本 ${positives.length} 个 / 负样本 ${negatives.length} 个`);

  const target = getArg('rules', null) ?? args.find((a) => a.startsWith('--rules='))?.slice(8);
  const all = args.includes('--all');
  const subscription = getArg('subscription', null);
  const jsonOut = args.includes('--json');

  /* ---- 订阅结构模式 ---- */
  if (subscription) {
    let parsed;
    try {
      parsed = JSON5.parse(await readFile(subscription, 'utf8'));
    } catch (e) {
      console.error(`[validate] ${subscription} 解析失败: ${e.message}`);
      process.exit(1);
    }
    const { problems, stats } = validateSubscriptionStructure(parsed);
    if (jsonOut) {
      console.log(JSON.stringify({ mode: 'subscription', file: subscription, stats, problems }, null, 2));
    } else {
      log(`订阅结构校验：${subscription}`);
      log(
        `  apps=${stats.apps} groups=${stats.groups} rules=${stats.rules} ` +
          `globalGroups=${stats.globalGroups} 选择器=${stats.selectors}`,
      );
      if (problems.length) {
        warn(`发现 ${problems.length} 个结构问题：`);
        problems.slice(0, 50).forEach((p) => warn(`  ✗ ${p}`));
        if (problems.length > 50) warn(`  ...其余 ${problems.length - 50} 个省略`);
      } else {
        log('结构自洽性检查通过');
      }
    }
    process.exit(problems.length > 0 ? 1 : 0);
  }

  /* ---- 自建规则模式 ---- */
  let ruleFiles = [];
  if (all) {
    const dir = 'rules/local';
    if (existsSync(dir)) {
      ruleFiles = (await readdir(dir))
        .filter((f) => f.endsWith('.json5') || f.endsWith('.json'))
        .map((f) => path.join(dir, f));
    }
  } else if (target) {
    ruleFiles = [target];
  } else {
    console.error('用法: --rules <file> | --all | --subscription <file>');
    process.exit(1);
  }

  const results = [];
  let pass = 0;
  let fail = 0;
  for (const file of ruleFiles) {
    let parsed;
    try {
      parsed = JSON5.parse(await readFile(file, 'utf8'));
    } catch (e) {
      warn(`${file} 解析失败: ${e.message}`);
      fail++;
      continue;
    }
    const apps = parsed.apps ?? [{ id: parsed.id, groups: parsed.groups ?? [] }];
    for (const app of apps) {
      for (const group of app.groups ?? []) {
        for (const r of group.rules ?? []) {
          // 目标快照：同 App 的正样本
          const targetSnaps = positives.filter((s) => s.appId === app.id);
          const res = validateRule(
            { appId: app.id, groupName: group.name, rule: r },
            targetSnaps[0],
            snapshots,
            { scope: 'app', checkIdOwnership: true },
          );
          results.push({
            file,
            appId: app.id,
            group: group.name,
            pass: res.pass,
            reasons: res.reasons,
            warnings: res.warnings,
          });
          if (res.pass) {
            pass++;
          } else {
            fail++;
            warn(`✗ ${app.id} / ${group.name}: ${res.reasons.join('; ')}`);
          }
          for (const w of res.warnings) warn(`  ⚠ ${app.id} / ${group.name}: ${w}`);
        }
      }
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({ mode: 'rules', pass, fail, results }, null, 2));
  } else {
    log(`校验完成：通过 ${pass}，失败 ${fail}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

// 仅当本文件是直接执行的入口时才跑 CLI。
// process.argv[1] 在 `node -e` 或被 import 时可能为 undefined，
// 直接 pathToFileURL(undefined) 会抛 TypeError —— 用可选链先做保护。
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((e) => {
    console.error('[validate][fatal]', e);
    process.exit(1);
  });
}
