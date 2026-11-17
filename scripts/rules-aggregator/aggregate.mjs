#!/usr/bin/env node
/**
 * 规则聚合器（L1 层核心）
 *
 * 职责：把多个社区订阅源 + 本项目自建规则，合并成一份稳定、唯一、可自动更新的订阅文件。
 *
 * 关键设计：
 *  1. 单源失败不阻塞整体 —— 任一源 404/超时/解析失败，只记录并跳过。这保证「供给侧自主可控」：
 *     社区源随时可能停更，但你的聚合产物不会因此挂掉。
 *  2. 去重按「包名 + 组名 + 规则内容指纹」三层。同一 App 的不同组保留（它们可能匹配不同场景），
 *     完全相同的规则只留一份，避免 GKD 端重复触发（重复订阅同源是最常见的卡顿原因）。
 *  3. 冲突检测：同一个 App 出现两条 selector 完全相同但 action 不同的规则时告警 ——
 *     这通常意味着两个社区源对同一界面的理解不一致，需要人工介入。
 *  4. 版本号单调递增：读取本地 dist/gkd.version.json5 的历史 version，加 1。
 *     GKD 客户端只有在 version 变大时才更新，所以这里必须严格单调。
 *
 * 用法：
 *   node ./scripts/rules-aggregator/aggregate.mjs [--out-dir dist] [--dry-run]
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import {
  SOURCES,
  LOCAL_RULES_DIR,
  OUTPUT_SUBSCRIPTION_ID,
  OUTPUT_UPDATE_URL,
  OUTPUT_CHECK_UPDATE_URL,
  checkDeployUrl,
} from './sources.mjs';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT_DIR = getArg('out-dir', 'dist');
const DRY_RUN = args.includes('--dry-run');
const TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const log = (...a) => console.log('[aggregate]', ...a);
const warn = (...a) => console.warn('[aggregate][warn]', ...a);

async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'gkd-skip-ad-aggregator/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 稳定指纹：对对象做键排序后序列化，保证同样内容得到同样哈希。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fingerprint(obj) {
  // FNV-1a 32bit，足够用于去重指纹
  const s = stableStringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 取出规则里真正决定「点哪里」的部分，用于冲突检测。 */
function actionSignature(rule) {
  const sels = selectorListOf(rule).join('|');
  const acts = selectorListOf(rule)
    .map((_, i) => (Array.isArray(rule.rules) ? rule.rules[i] : rule.rules)?.action ?? 'click')
    .join('|');
  return `${sels}::${acts}`;
}

/**
 * matches 字段有两种形态（GKD 的 RawRuleProps.matches: List<String>?）：
 *   - 单个字符串：'[text="跳过"]'
 *   - 字符串数组：['[text="a"]','[text="b"]']，表示「命中任意一个即可」
 * 统一成数组处理，避免把数组误当字符串（会导致编译崩溃）。
 */
function selectorListOf(rule) {
  const m = rule?.matches;
  if (Array.isArray(m)) return m.filter(Boolean);
  if (typeof m === 'string' && m.length) return [m];
  return [];
}

/**
 * 冲突检测的作用域键：App + 组名 + 选择器。
 *
 * 分隔符用 \u0000（NUL）而不是空格 —— GKD 选择器里常含空格
 * （如 `[text="跳过"] > [id="x"]`），用空格会把不同选择器粘成同一个键。
 */
const scopeKeyOf = (appId, groupName, selector) =>
  `${appId}\u0000${groupName}\u0000${selector}`;

/**
 * 动作族划分 —— 用于判断两条规则的动作差异是否真的需要人工介入。
 *
 * 依据上游 ActionPerformer 的实现：
 *   click      -> 若节点可点击则走 clickNode，否则回退 clickCenter
 *   clickNode  -> AccessibilityNodeInfo.performAction(ACTION_CLICK)
 *   clickCenter-> 按坐标点击节点中心
 * 三者作用在同一节点上，最终效果基本等价 —— `click` 是另两者的超集。
 * 所以「同选择器 click vs clickCenter」**不是**真冲突，只是写法差异，
 * 合并时保留哪条都无所谓，不该占用人工确认的注意力。
 *
 * 而 click vs back / swipe 语义完全不同（一个点界面、一个退页面），
 * 先执行哪个会改变页面状态导致另一条永不触发 —— 这才是真冲突。
 */
const CLICK_FAMILY = new Set(['click', 'clickNode', 'clickCenter']);

/**
 * 判定两个动作是否属于同一族（等价）。
 * @returns {'equivalent'|'conflict'}
 */
function actionRelation(a, b) {
  if (a === b) return 'equivalent';
  if (CLICK_FAMILY.has(a) && CLICK_FAMILY.has(b)) return 'equivalent';
  return 'conflict';
}

/* ------------------------------------------------------------------ */
/* 拉取                                                                */
/* ------------------------------------------------------------------ */

async function fetchSource(src) {
  const errors = [];
  for (const url of src.mirrors) {
    try {
      const text = await fetchWithTimeout(url);
      const parsed = JSON5.parse(text);
      if (!parsed || !Array.isArray(parsed.apps)) {
        throw new Error('解析结果缺少 apps 数组');
      }
      return { ok: true, url, text, data: parsed };
    } catch (e) {
      errors.push(`${url} -> ${e.message}`);
    }
  }
  return { ok: false, errors };
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

/**
 * 重排合并后组内的 rule key，并重映射所有按 key 的引用。
 *
 * 为什么必须这么做：
 *   上游按 key 在**组内**查找兄弟规则来建立依赖 ——
 *     preKeys        : 本规则依赖的前置规则（共享状态）
 *     actionCdKey    : 与该规则共享冷却计数
 *     actionMaximumKey: 与该规则共享执行次数上限
 *   查找方式是 `groupRules.find { r -> r.key == actionCdKey }`（取第一个匹配），
 *   而 preKeys 更是 `filter { parameters.preKeys.contains(otherRule.key) }`（取全部匹配）。
 *
 *   但每个社区源的 key 都是**从 0 开始独立编号**的。合并多个源到同一组后，
 *   key 会大面积重复 —— 实测 3727 个组里有 445 个组出现重复 key，
 *   425 个组带有 key 引用。此时 `find` 会命中错误的规则，
 *   `filter` 会把无关规则也拉成依赖，导致冷却/次数上限串到别的规则上。
 *
 * 做法：给组内规则重新分配唯一 key（0..n-1），再用每个源自己的
 * 「原始 key -> 指纹 -> 新 key」映射把引用改写到新 key。
 *
 * @param {object} slot  { rules: Map<fingerprint, rule>, keyMap: Map<srcId, Map<origKey, fingerprint>> }
 * @returns {Array} 重排后的规则数组
 */
function renumberRuleKeys(slot) {
  const entries = [...slot.rules.entries()]; // [fingerprint, rule]
  if (entries.length === 0) return { rules: [], groupRemap: {} };

  // 指纹 -> 新 key
  const fpToNewKey = new Map();
  entries.forEach(([fp], i) => fpToNewKey.set(fp, i));

  // 源内 原始key -> 新key
  const srcToNewKey = new Map();
  for (const [srcId, origToFp] of slot.keyMap ?? []) {
    const m = new Map();
    for (const [origKey, fp] of origToFp) {
      const nk = fpToNewKey.get(fp);
      if (nk !== undefined) m.set(origKey, nk);
    }
    srcToNewKey.set(srcId, m);
  }

  const rules = entries.map(([, r], i) => {
    const c = { ...r };
    delete c._src;
    delete c._weight;
    delete c._origKey;
    c.key = i;
    const map = srcToNewKey.get(r._src) ?? new Map();
    const remap = (k) => {
      if (k === undefined || k === null) return undefined;
      const nk = map.get(k);
      return nk === undefined ? undefined : nk;
    };
    // preKeys 是数组
    if (Array.isArray(c.preKeys)) {
      const mapped = c.preKeys.map(remap).filter((v) => v !== undefined);
      if (mapped.length) c.preKeys = [...new Set(mapped)];
      else delete c.preKeys;
    }
    // 单值引用
    for (const k of ['actionCdKey', 'actionMaximumKey']) {
      const nk = remap(c[k]);
      if (nk === undefined) delete c[k];
      else c[k] = nk;
    }
    return c;
  });

  // 组级引用（group.actionCdKey / group.actionMaximumKey）同样按 key 指向组内规则。
  // 组级属性取自权重最高的源，所以要用同一个源的映射来重映射。
  const groupMap = srcToNewKey.get(slot._metaSrc) ?? new Map();
  const groupRemap = {};
  for (const k of ['actionCdKey', 'actionMaximumKey']) {
    if (slot._meta?.[k] === undefined || slot._meta?.[k] === null) continue;
    const nk = groupMap.get(slot._meta[k]);
    if (nk !== undefined) groupRemap[k] = nk;
  }
  return { rules, groupRemap };
}

/**
 * 把单个订阅源的 apps 摊平成「包名 -> 组数组」的结构。
 * 保留原始 group 对象，附加 _src/_weight 便于溯源。
 *
 * 注意：group 上的所有字段（desc / enable / scopeKeys / actionCd / order /
 * forcedTime / priorityTime / ignoreGlobalGroupMatch / versionCode …）都原样保留。
 * 上游 RawAppGroup 的字段很多，任何一个被丢掉都可能改变匹配语义，
 * 所以这里只重置 key（合并后要重排）。
 */
function flattenApps(subscription, sourceId, weight) {
  const out = new Map();
  for (const app of subscription.apps ?? []) {
    if (!app?.id) continue;
    const groups = Array.isArray(app.groups) ? app.groups : [];
    const list = out.get(app.id) ?? [];
    for (const g of groups) {
      if (!g) continue;
      list.push({
        ...g,
        key: undefined, // key 由客户端分配，合并后重排
        _src: sourceId,
        _weight: weight,
      });
    }
    out.set(app.id, list);
  }
  return out;
}

/**
 * 摊平全局组（globalGroups）。
 *
 * 全局组是 GKD 里「不限定 App、开屏广告通用规则」的载体 —— 实测每个社区源都有
 * 3~9 个全局组，其中「开屏广告-全局」覆盖 300+ App，是实际命中率最高的部分。
 * **合并器早期版本直接把 globalGroups 写成空数组，等于丢掉了这部分规则。**
 *
 * 全局组的合并主键是「组名」，因为全局组没有 App 维度。
 */
function flattenGlobalGroups(subscription, sourceId, weight) {
  const groups = Array.isArray(subscription.globalGroups) ? subscription.globalGroups : [];
  return groups
    .filter((g) => g && g.name)
    .map((g) => ({
      ...g,
      key: undefined,
      _src: sourceId,
      _weight: weight,
    }));
}

/** 单条规则的内容指纹（去掉与内容无关的元数据）。 */
function ruleFingerprint(group) {
  const rules = Array.isArray(group.rules) ? group.rules : group.rules ? [group.rules] : [];
  return fingerprint(
    rules.map((r) => ({
      matches: selectorListOf(r),
      action: r.action,
      activityIds: r.activityIds,
      matchTime: r.matchTime,
      actionMaximum: r.actionMaximum,
    })),
  );
}

/**
 * 合并策略（关键）：
 *
 *  以「包名 + 组名」为主键合并，而不是简单拼接。这样 4 个社区源对同一个 App 的
 *  「开屏广告」组会合并成一组，组内规则取并集去重 —— 这才是「一个订阅解决所有问题」的意义，
 *  也避免了 GKD 端多份同源订阅重复触发（官方文档明确指出同源订阅并行是最亏的用法）。
 *
 *  真正的冲突只有一种：**同一个选择器指向不同动作**。例如 aisouler 说点关闭按钮、
 *  adpro 说点跳过按钮 —— 这种必须报出来人工确认，因为先执行哪个会改变页面状态。
 *  组名相同但选择器不同不冲突，直接取并集。
 *
 *  ⚠️ 冲突必须按「App + 组名」作用域比较，不能全局比较。
 *  早期实现用一个全局的 selector -> action 映射，导致 A App 的 `[text="跳过"]`（click）
 *  和 B App 的 `[text="跳过"]`（clickCenter）被判为冲突 —— 但这两条规则根本不会在同一个
 *  App 里同时生效，不存在「先执行哪个改变页面状态」的问题。
 *  实测该缺陷造成 76 处报告 vs 8 处真实冲突，噪声比真实信号高一个数量级，
 *  真正的冲突会被淹没在误报里。
 */
function mergeSources(fetched) {
  // appId -> groupName -> { name, rules: Map<fingerprint, rule>, srcs:Set }
  const merged = new Map();
  const conflicts = [];
  // 记录 (appId + 组名 + selector) -> action，只在同 App 同组内比较
  const selectorActions = new Map();
  // 全局组：组名 -> { name, rules: Map<fingerprint, rule>, srcs:Set, _meta }
  const mergedGlobal = new Map();
  // 分类：name -> category（用于 GKD 客户端里的分组展示）
  const mergedCategories = new Map();

  for (const src of fetched) {
    // 分类合并：同名取权重更高者
    for (const c of src.data.categories ?? []) {
      if (!c?.name) continue;
      const prevCat = mergedCategories.get(c.name);
      if (!prevCat || src.weight > (prevCat._weight ?? 0)) {
        mergedCategories.set(c.name, { ...c, _weight: src.weight });
      }
    }

    // 全局组合并（与 App 组同策略：按组名取并集，组内规则去重）
    for (const g of flattenGlobalGroups(src.data, src.id, src.weight)) {
      const name = g.name;
      const gslot = mergedGlobal.get(name) ?? {
        name,
        rules: new Map(),
        srcs: new Set(),
        keyMap: new Map(),
      };
      gslot.srcs.add(src.id);
      const rawRules = Array.isArray(g.rules) ? g.rules : g.rules ? [g.rules] : [];
      for (const r of rawRules) {
        if (!r) continue;
        const fp = ruleFingerprint({ rules: [r] });
        const gSrcKeyMap = gslot.keyMap.get(src.id) ?? new Map();
        if (r.key !== undefined && r.key !== null) gSrcKeyMap.set(r.key, fp);
        gslot.keyMap.set(src.id, gSrcKeyMap);
        if (!gslot.rules.has(fp)) {
          gslot.rules.set(fp, { ...r, _src: src.id, _weight: src.weight, _origKey: r.key });
        }
      }
      // 全局组的 apps 是「该组适用的 App 白名单」，跨源取并集（覆盖面只增不减）
      const appScope = gslot._apps ?? new Map();
      for (const a of g.apps ?? []) {
        if (!a?.id) continue;
        const prevApp = appScope.get(a.id);
        // 同一 App 的作用域条目取权重更高者
        if (!prevApp || src.weight > (prevApp._weight ?? 0)) {
          appScope.set(a.id, { ...a, _src: src.id, _weight: src.weight });
        }
      }
      gslot._apps = appScope;
      // 组级属性以权重最高的源为准
      if (!gslot._meta || src.weight > (gslot._metaWeight ?? 0)) {
        gslot._meta = { group: g };
        gslot._metaWeight = src.weight;
        gslot._metaSrc = src.id;
      }
      mergedGlobal.set(name, gslot);
    }

    const flat = flattenApps(src.data, src.id, src.weight);
    for (const [appId, groups] of flat) {
      const appMap = merged.get(appId) ?? new Map();
      for (const g of groups) {
        const name = g.name ?? '未命名组';
        const slot = appMap.get(name) ?? {
          name,
          rules: new Map(),
          srcs: new Set(),
          keyMap: new Map(),
        };
        slot.srcs.add(src.id);
        const rawRules = Array.isArray(g.rules) ? g.rules : g.rules ? [g.rules] : [];
        for (const r of rawRules) {
          if (!r) continue;
          const fp = ruleFingerprint({ rules: [r] });
          // keyMap: 源内原始 key -> 该规则指纹。
          // 用于合并后重排 key 时，把 preKeys / actionCdKey / actionMaximumKey 重新指向正确的新 key。
          const srcKeyMap = slot.keyMap.get(src.id) ?? new Map();
          if (r.key !== undefined && r.key !== null) srcKeyMap.set(r.key, fp);
          slot.keyMap.set(src.id, srcKeyMap);
          if (!slot.rules.has(fp)) {
            slot.rules.set(fp, { ...r, _src: src.id, _weight: src.weight, _origKey: r.key });
          }

          // 同组内检测：同一选择器出现在同一 App 的同一组且动作不同 → 冲突
          // matches 可能是数组，数组内每个选择器语义是「或」，故逐个比对。
          // 作用域键包含 appId 与组名 —— 跨 App 的相同选择器不构成冲突。
          const act = r.action ?? 'click';
          for (const sel of selectorListOf(r)) {
            const scopeKey = scopeKeyOf(appId, name, sel);
            const prev = selectorActions.get(scopeKey);
            if (prev) {
              // 动作族等价（如 click vs clickCenter）只是写法差异，不算冲突
              if (actionRelation(prev.action, act) === 'conflict') {
                conflicts.push({
                  appId,
                  group: name,
                  selector: sel,
                  actions: [prev.action, act],
                  sources: [prev.src, src.id],
                });
              }
            } else {
              selectorActions.set(scopeKey, { action: act, src: src.id, appId, group: name });
            }
          }
        }
        // 组级属性（非规则级）以权重最高的源为准。
        // 整组透传而非白名单挑选 —— 上游 RawAppGroup 的字段大多参与匹配语义。
        if (!slot._meta || src.weight > (slot._metaWeight ?? 0)) {
          slot._meta = { ...g };
          delete slot._meta.key;
          delete slot._meta.rules;
          slot._metaWeight = src.weight;
          slot._metaSrc = src.id;
        }
        appMap.set(name, slot);
      }
      merged.set(appId, appMap);
    }
  }
  return { merged, mergedGlobal, mergedCategories, conflicts };
}

/* ------------------------------------------------------------------ */
/* 本地自建规则                                                        */
/* ------------------------------------------------------------------ */

async function loadLocalRules(dir) {
  const rules = [];
  if (!existsSync(dir)) return rules;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json5') || f.endsWith('.json'));
  for (const f of files) {
    try {
      const text = await readFile(path.join(dir, f), 'utf8');
      const parsed = JSON5.parse(text);
      rules.push({ ...parsed, _file: f });
    } catch (e) {
      warn(`本地规则 ${f} 解析失败，已跳过: ${e.message}`);
    }
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function readPrevVersion(outDir) {
  try {
    const text = await readFile(path.join(outDir, 'gkd.version.json5'), 'utf8');
    return JSON5.parse(text).version ?? 0;
  } catch {
    return 0;
  }
}

async function main() {
  // 部署地址检查：占位符地址写进订阅后，客户端首次添加没问题、但自动更新必失败。
  // 这类错在表面上看不出来，所以要么在构建时拦下，要么明确告知。
  const urlProblem = checkDeployUrl();
  if (urlProblem) {
    if (args.includes('--strict-url')) {
      console.error(`[aggregate][fatal] ${urlProblem}`);
      process.exit(1);
    }
    warn(urlProblem);
    warn('提示：用 --strict-url 可让这种情况直接失败（CI 里建议开启）。');
  }
  log(`源清单：${SOURCES.length} 个社区源 + 本地自建规则`);
  log(`输出目录：${OUT_DIR}${DRY_RUN ? '（dry-run，不写文件）' : ''}`);

  const fetched = [];
  for (const src of SOURCES) {
    const r = await fetchSource(src);
    if (!r.ok) {
      warn(`源 ${src.name} 全部镜像失败，已跳过：`);
      r.errors.forEach((e) => warn(`    ${e}`));
      continue;
    }
    const apps = r.data.apps?.length ?? 0;
    log(`✓ ${src.name}: id=${r.data.id} v=${r.data.version} apps=${apps} (${r.url})`);
    fetched.push({ ...r, id: src.id, weight: src.weight });
  }

  if (fetched.length === 0) {
    console.error('[aggregate][fatal] 没有任何源可用，终止。');
    process.exit(1);
  }
  if (fetched.length < SOURCES.length) {
    warn(`注意：${SOURCES.length - fetched.length} 个源不可用，本次产物基于 ${fetched.length} 个源。`);
  }

  const { merged, mergedGlobal, mergedCategories, conflicts } = mergeSources(fetched);
  const localRules = await loadLocalRules(LOCAL_RULES_DIR);
  if (localRules.length) log(`本地自建规则：${localRules.length} 个 App`);

  // 本地自建规则（LLM 自动修复产出）以最高优先级合并。
  // 组名加 "(auto)" 后缀，避免与社区源的同名组被合并 —— 自建规则是经过校验器
  // 验证的，应当独立成组，便于单独禁用或回滚。
  for (const lr of localRules) {
    const appMap = merged.get(lr.id) ?? new Map();
    for (const g of lr.groups ?? []) {
      const rawRules = Array.isArray(g.rules) ? g.rules : g.rules ? [g.rules] : [];
      const slot = {
        name: `${g.name ?? '未命名组'} (auto)`,
        rules: new Map(),
        srcs: new Set(['local']),
        _meta: { ...g, key: undefined, rules: undefined },
      };
      for (const r of rawRules) {
        if (!r) continue;
        slot.rules.set(ruleFingerprint({ rules: [r] }), { ...r, _src: 'local', _weight: 1000 });
      }
      appMap.set(slot.name, slot);
    }
    merged.set(lr.id, appMap);
  }

  const apps = [];
  let totalGroups = 0;
  let totalRules = 0;
  for (const [appId, appMap] of merged) {
    const groups = [];
    let idx = 0;
    for (const slot of appMap.values()) {
      // 重排 key 并重映射按 key 的引用（preKeys / actionCdKey / actionMaximumKey）
      const { rules, groupRemap } = renumberRuleKeys(slot);
      if (rules.length === 0) continue;
      const meta = slot._meta ?? {};
      const group = {
        key: idx++,
        name: slot.name,
        rules,
      };
      // 保留组级属性。
      // 早期实现只搬运 activityIds/matchTime/actionMaximum/resetMatch/fastQuery/matchRoot
      // 这 7 个字段，把 desc / enable / scopeKeys / order / forcedTime / priorityTime /
      // actionCd / actionDelay / matchDelay / actionCdKey / actionMaximumKey /
      // ignoreGlobalGroupMatch / versionCode / versionName 等全丢了。
      // 上游 RawAppGroup 这些字段都参与匹配语义（尤其 order 决定组优先级、
      // forcedTime 决定强匹配窗口、ignoreGlobalGroupMatch 决定全局组是否被抑制），
      // 丢字段 = 行为静默改变。所以这里整组透传，只剔除内部字段。
      for (const [k, v] of Object.entries(meta)) {
        if (k.startsWith('_')) continue;
        if (v === undefined || v === null) continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
        group[k] = v;
      }
      // 组级 key 引用已被重映射到新 key
      for (const [k, v] of Object.entries(groupRemap)) group[k] = v;
      groups.push(group);
      totalRules += rules.length;
    }
    if (groups.length === 0) continue;
    totalGroups += groups.length;
    apps.push({ id: appId, groups });
  }

  if (conflicts.length) {
    // 区分跨源冲突（更值得关注）与同源冲突（社区源内部版本差异）。
    const cross = conflicts.filter((c) => c.sources[0] !== c.sources[1]);
    const intraList = conflicts.filter((c) => c.sources[0] === c.sources[1]);
    warn(`检测到 ${conflicts.length} 处「同选择器不同动作」冲突：`);
    if (cross.length) {
      warn(`  其中跨源冲突 ${cross.length} 处（优先级最高，需人工确认）：`);
      cross.slice(0, 10).forEach((c) =>
        warn(`    ${c.appId} / ${c.group}: [${c.sources.join(' vs ')}] actions=${c.actions.join('/')}`),
      );
    }
    if (intraList.length) {
      warn(`  同源冲突 ${intraList.length} 处（社区源内部版本差异，通常无害，已取并集）：`);
      intraList.slice(0, 3).forEach((c) => warn(`    ${c.appId} / ${c.group}`));
      if (intraList.length > 3) warn(`    ...其余 ${intraList.length - 3} 处省略`);
    }
  }

  // 生成全局组输出。
  // 全局组是「不限 App 的通用规则」，实测社区源的「开屏广告-全局」覆盖 300+ App，
  // 是命中率最高的部分 —— 早期实现把 globalGroups 写成空数组，等于整块丢失。
  const globalGroups = [];
  let gIdx = 0;
  let totalGlobalRules = 0;
  for (const slot of mergedGlobal.values()) {
    const { rules, groupRemap } = renumberRuleKeys(slot);
    if (rules.length === 0) continue;
    const meta = slot._meta?.group ?? {};
    const gg = {
      key: gIdx++,
      name: slot.name,
      rules,
    };
    // 组级属性整组透传（与 App 组一致），只剔除内部字段与 undefined。
    for (const [k, v] of Object.entries(meta)) {
      if (k.startsWith('_')) continue;
      if (k === 'key' || k === 'name' || k === 'rules') continue;
      if (v === undefined || v === null) continue;
      if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
      gg[k] = v;
    }
    // 组级 key 引用已被重映射到新 key
    for (const [k, v] of Object.entries(groupRemap)) gg[k] = v;
    // apps 是全局组的 App 白名单：跨源取并集后写回
    const appScope = slot._apps ?? new Map();
    if (appScope.size > 0) {
      gg.apps = [...appScope.values()].map((a) => {
        const c = { ...a };
        delete c._src;
        delete c._weight;
        return c;
      });
    }
    globalGroups.push(gg);
    totalGlobalRules += rules.length;
  }

  const prevVersion = await readPrevVersion(OUT_DIR);
  const version = prevVersion + 1;

  const subscription = {
    id: OUTPUT_SUBSCRIPTION_ID,
    name: '跳开屏广告 · 自动聚合订阅',
    version,
    author: 'auto-aggregator',
    updateUrl: OUTPUT_UPDATE_URL,
    checkUpdateUrl: OUTPUT_CHECK_UPDATE_URL,
    supportUri: 'https://github.com/gkd-kit/gkd',
    // 分类：合并后重排 key，保证唯一。
    // 各社区源各自从 0 开始编号，合并后必然重复
    // （实测「功能类」与「综合广告」都是 key=9）。
    // key 重复虽不影响 GKD 的按名字匹配，但会让客户端的分类排序/筛选行为不确定。
    categories: [...mergedCategories.values()]
      .sort((a, b) => (a.key ?? 0) - (b.key ?? 0) || a.name.localeCompare(b.name))
      .map((c, index) => {
        const out = { ...c, key: index };
        delete out._weight;
        return out;
      }),
    globalGroups,
    apps,
  };

  log(
    `合并完成：apps=${apps.length} groups=${totalGroups} rules=${totalRules} ` +
      `全局组=${globalGroups.length}（${totalGlobalRules} 条规则） version=${version}`,
  );

  if (DRY_RUN) {
    log('dry-run 模式，未写入文件。');
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const body = `// 本文件由 scripts/rules-aggregator/aggregate.mjs 自动生成，请勿手工编辑。
// 生成时间: ${new Date().toISOString()}
// version: ${version}
{
  id: ${OUTPUT_SUBSCRIPTION_ID},
  name: '${subscription.name}',
  version: ${version},
  author: 'auto-aggregator',
  updateUrl: '${OUTPUT_UPDATE_URL}',
  checkUpdateUrl: '${OUTPUT_CHECK_UPDATE_URL}',
  supportUri: '${subscription.supportUri}',
  categories: ${JSON.stringify(subscription.categories)},
  globalGroups: ${JSON.stringify(subscription.globalGroups)},
  apps: ${JSON.stringify(subscription.apps)},
}
`;
  await writeFile(path.join(OUT_DIR, 'gkd.json5'), body, 'utf8');
  await writeFile(
    path.join(OUT_DIR, 'gkd.version.json5'),
    `{\n  id: ${OUTPUT_SUBSCRIPTION_ID},\n  version: ${version},\n}\n`,
    'utf8',
  );
  log(`已写入 ${OUT_DIR}/gkd.json5 与 ${OUT_DIR}/gkd.version.json5`);
}

main().catch((e) => {
  console.error('[aggregate][fatal]', e);
  process.exit(1);
});
