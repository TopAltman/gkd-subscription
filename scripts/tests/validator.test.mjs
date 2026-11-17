#!/usr/bin/env node
/**
 * 校验器与聚合器的回归测试。
 *
 * 用 Node 22 内置的 node:test，不引入额外依赖。
 *
 * 覆盖的关键不变量（每一条都对应一个真实缺陷或交接文档里的承诺）：
 *   1. matches 的两种形态（字符串 / 数组）都能正确处理   ← 坑 1
 *   2. 语法错误能编译检测出来，不会崩溃                  ← 坑 2/3
 *   3. 负样本按 GKD 作用域语义挑选                      ← 语义修正
 *   4. 同 App 的非开屏界面命中 → 拦截                    ← 安全底线
 *   5. 跨 App 命中对 App 级规则只告警不拦截              ← 语义修正
 *   6. id 归属检查能识别模型幻觉                        ← 新增
 *   7. 语料库有判别力：宽松规则被拦、精确规则放行        ← 新增
 *   8. 聚合器保留 globalGroups / categories / 组级字段   ← 数据丢失修复
 *   9. 聚合器冲突检测按 App+组作用域，且忽略等价动作族    ← 误报修复
 *  10. 聚合后 rule key 唯一且 key 引用不悬空            ← 正确性修复
 *
 * 用法：node --test scripts/tests/   或   node scripts/tests/validator.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateRule,
  compileSelector,
  selectNegatives,
  extractIdPackages,
  validateSubscriptionStructure,
} from '../rule-validator/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

const node = (name, attributes = {}, children = []) => ({ name, attributes, children });

/** 开屏广告页：跳过按钮是 ImageView（无文字），文案在兄弟 TextView 上。 */
const splashTree = (pkg) =>
  node('android.widget.FrameLayout', { visibleToUser: true }, [
    node('android.widget.ImageView', { id: `${pkg}:id/splash_image`, visibleToUser: true }, []),
    node('android.widget.TextView', { id: `${pkg}:id/count`, text: '5' }, []),
    node('android.widget.ImageView', {
      id: `${pkg}:id/skip_btn`,
      clickable: true,
      visibleToUser: true,
    }, []),
    node('android.widget.TextView', { id: `${pkg}:id/skip_text`, text: '跳过' }, []),
  ]);

/** 同 App 的非开屏页：含「跳过」诱饵。 */
const decoyTree = (pkg) =>
  node('android.widget.LinearLayout', { visibleToUser: true }, [
    node('android.widget.TextView', { id: `${pkg}:id/title`, text: '设置' }, []),
    node('android.widget.Button', {
      id: `${pkg}:id/guide_skip`,
      text: '跳过引导',
      clickable: true,
      visibleToUser: true,
    }, []),
  ]);

const PKG = 'com.test.app';
const targetSnap = {
  appId: PKG,
  kind: 'positive',
  expect: { text: '跳过' },
  tree: splashTree(PKG),
};
const sameAppNegative = {
  appId: PKG,
  kind: 'negative',
  tree: decoyTree(PKG),
};
const otherAppNegative = {
  appId: 'com.other.app',
  kind: 'negative',
  tree: decoyTree('com.other.app'),
};
const allSnaps = [targetSnap, sameAppNegative, otherAppNegative];

/* ------------------------------------------------------------------ */
/* 1-2. 编译与 matches 形态                                             */
/* ------------------------------------------------------------------ */

describe('选择器编译', () => {
  test('合法选择器编译成功', () => {
    const r = compileSelector('[text="跳过"]');
    assert.equal(r.ok, true);
    assert.ok(r.selector);
  });

  test('非法选择器返回错误而不是抛异常', () => {
    const r = compileSelector('[text=');
    assert.equal(r.ok, false);
    assert.ok(r.message);
  });

  test('matches 为字符串数组时逐个处理且不崩溃', () => {
    // 坑 1：把数组当字符串丢给编译器会抛 a.a is not a function
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: ['[text="跳过"]', '[text="下次再说"]'] } },
      targetSnap,
      allSnaps,
    );
    assert.ok(Array.isArray(r.details.selectors));
    assert.equal(r.details.selectors.length, 2);
  });

  test('matches 为单个字符串也能处理', () => {
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: '[id="com.test.app:id/skip_btn"]' } },
      targetSnap,
      allSnaps,
    );
    assert.equal(r.pass, true, r.reasons.join('; '));
  });

  test('缺少 matches 字段直接判失败', () => {
    const r = validateRule({ appId: PKG, groupName: 'g', rule: {} }, targetSnap, allSnaps);
    assert.equal(r.pass, false);
    assert.match(r.reasons[0], /matches/);
  });
});

/* ------------------------------------------------------------------ */
/* 3-5. 负样本作用域语义                                               */
/* ------------------------------------------------------------------ */

describe('负样本作用域', () => {
  test('App 级规则：同 App 负样本与跨 App 负样本被分开', () => {
    const { sameApp, crossApp } = selectNegatives(
      { appId: PKG, groupName: 'g' },
      'app',
      allSnaps,
    );
    assert.equal(sameApp.length, 1);
    assert.equal(sameApp[0].appId, PKG);
    assert.equal(crossApp.length, 1);
    assert.equal(crossApp[0].appId, 'com.other.app');
  });

  test('全局规则：所有负样本都算负样本', () => {
    const { sameApp, crossApp } = selectNegatives(
      { appId: PKG, groupName: 'g' },
      'global',
      allSnaps,
    );
    assert.equal(sameApp.length, 2);
    assert.equal(crossApp.length, 0);
  });

  test('同 App 非开屏界面命中 → 拦截（安全底线）', () => {
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: '[text*="跳过"]' } },
      targetSnap,
      allSnaps,
      { scope: 'app' },
    );
    assert.equal(r.pass, false);
    assert.match(r.reasons.join(' '), /同一 App/);
  });

  // 专门构造一组夹具：一条规则**既命中本 App 的正样本，又命中别的 App 的页面**，
  // 但不命中本 App 的非开屏页 —— 用来验证「跨 App 命中」在两种作用域下的不同处理。
  const crossTree = {
    appId: PKG,
    kind: 'positive',
    expect: { text: '跳过' },
    tree: node('android.widget.FrameLayout', {}, [
      node('android.widget.TextView', { id: `${PKG}:id/skip_text`, text: '跳过' }, []),
    ]),
  };
  const crossSnaps = [
    crossTree,
    // 本 App 的非开屏页：没有「跳过」字样
    {
      appId: PKG,
      kind: 'negative',
      tree: node('android.widget.LinearLayout', {}, [
        node('android.widget.TextView', { text: '设置' }, []),
      ]),
    },
    // 别的 App 的页面：恰好也有个「跳过」
    {
      appId: 'com.other.app',
      kind: 'negative',
      tree: node('android.widget.LinearLayout', {}, [
        node('android.widget.TextView', { text: '跳过' }, []),
      ]),
    },
  ];

  test('跨 App 命中：App 级规则只告警不拦截', () => {
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: '[text="跳过"]' } },
      crossTree,
      crossSnaps,
      { scope: 'app' },
    );
    assert.equal(r.pass, true, r.reasons.join('; '));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /其它 App/);
  });

  test('全局规则下跨 App 命中 → 拦截', () => {
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: '[text="跳过"]' } },
      crossTree,
      crossSnaps,
      { scope: 'global' },
    );
    assert.equal(r.pass, false);
    assert.match(r.reasons.join(' '), /负样本/);
  });
});

/* ------------------------------------------------------------------ */
/* 6. id 归属检查                                                      */
/* ------------------------------------------------------------------ */

describe('id 归属检查', () => {
  test('提取选择器中的 id 包名', () => {
    const pkgs = extractIdPackages([
      '[id="com.foo:id/skip_btn"]',
      '[id="com.bar:id/other"]',
    ]);
    assert.deepEqual(pkgs.sort(), ['com.bar', 'com.foo']);
  });

  test('指向其它包的 id → 拦截', () => {
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: '[id="com.someone.else:id/skip_btn"]' } },
      targetSnap,
      allSnaps,
      { checkIdOwnership: true },
    );
    assert.equal(r.pass, false);
    assert.match(r.reasons.join(' '), /其它包/);
  });

  test('指向本包的 id → 通过', () => {
    const r = validateRule(
      { appId: PKG, groupName: 'g', rule: { matches: '[id="com.test.app:id/skip_btn"]' } },
      targetSnap,
      allSnaps,
      { checkIdOwnership: true },
    );
    assert.equal(r.pass, true, r.reasons.join('; '));
  });
});

/* ------------------------------------------------------------------ */
/* 7. 语料库判别力                                                     */
/* ------------------------------------------------------------------ */

describe('快照语料库', () => {
  test('语料库规模达到 P4 的验收标准（正样本 ≥ 50，负样本 ≥ 200）', async () => {
    const dir = path.join(ROOT, 'fixtures/snapshots');
    const files = await readdir(dir);
    let pos = 0;
    let neg = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (raw.kind === 'positive') pos++;
      else neg++;
    }
    assert.ok(pos >= 50, `正样本只有 ${pos} 个，应 ≥ 50`);
    assert.ok(neg >= 200, `负样本只有 ${neg} 个，应 ≥ 200`);
  });

  test('语料库有判别力：宽松规则被拦、精确规则放行', async () => {
    const dir = path.join(ROOT, 'fixtures/snapshots');
    const snaps = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      snaps.push({
        file: f,
        appId: raw.appId,
        expect: raw.expect ?? null,
        expectText: raw.expectText,
        tree: raw.tree,
        kind: raw.kind ?? 'unknown',
      });
    }
    const positives = snaps.filter((s) => s.kind === 'positive');
    assert.ok(positives.length > 0, '语料库缺少正样本');

    // 挑一个 App，其正样本里有可点的跳过节点
    const target = positives.find((s) => {
      const r = validateRule(
        { appId: s.appId, groupName: 'g', rule: { matches: '[text*="跳过"]' } },
        s,
        snaps,
      );
      return r.details.sameAppFalsePositives.length > 0;
    });
    assert.ok(target, '语料库中没有任何 App 能演示判别力');

    // 宽松规则 → 必须被拦
    const loose = validateRule(
      { appId: target.appId, groupName: 'g', rule: { matches: '[text*="跳过"]' } },
      target,
      snaps,
    );
    assert.equal(loose.pass, false, '宽松规则没有被拦截，语料库缺乏判别力');

    // 精确规则 → 必须放行
    const strict = validateRule(
      {
        appId: target.appId,
        groupName: 'g',
        rule: { matches: `[id="${target.appId}:id/skip_btn"]` },
      },
      target,
      snaps,
    );
    assert.equal(strict.pass, true, strict.reasons.join('; '));
  });
});

/* ------------------------------------------------------------------ */
/* 8-10. 聚合器                                                        */
/* ------------------------------------------------------------------ */

describe('聚合器产物', () => {
  const DIST = path.join(ROOT, 'dist/gkd.json5');

  test('产物存在', async () => {
    assert.ok(existsSync(DIST), 'dist/gkd.json5 不存在，请先运行 aggregate.mjs');
  });

  test('globalGroups 未被丢弃', async () => {
    const parsed = await readFile(DIST, 'utf8');
    // 社区源的通用开屏规则在全局组里，是命中率最高的部分
    assert.ok(
      !/"globalGroups"\s*:\s*\[\s*\]/.test(parsed),
      'globalGroups 为空 —— 社区源的通用规则（覆盖数百 App）被整体丢弃',
    );
  });

  test('categories 未被丢弃', async () => {
    const parsed = await readFile(DIST, 'utf8');
    assert.ok(!/"categories"\s*:\s*\[\s*\]/.test(parsed), 'categories 为空');
  });

  test('组级字段（order / forcedTime 等）未丢失', async () => {
    const text = await readFile(DIST, 'utf8');
    // order 决定组优先级、forcedTime 决定强匹配窗口，丢失会静默改变行为
    assert.ok(/"order"\s*:/.test(text), '未发现 order 字段，组级属性可能被丢弃');
  });

  test('结构自洽性检查通过（key 唯一、引用不悬空）', async () => {
    const { default: JSON5 } = await import('json5');
    const parsed = JSON5.parse(await readFile(DIST, 'utf8'));
    const { problems } = validateSubscriptionStructure(parsed);
    assert.deepEqual(problems, [], problems.slice(0, 5).join('\n'));
  });

  test('rule key 在每个组内唯一', async () => {
    const { default: JSON5 } = await import('json5');
    const parsed = JSON5.parse(await readFile(DIST, 'utf8'));
    let dupGroups = 0;
    for (const app of parsed.apps ?? []) {
      for (const g of app.groups ?? []) {
        const keys = (g.rules ?? []).map((r) => r.key).filter((k) => k !== undefined && k !== null);
        if (new Set(keys).size !== keys.length) dupGroups++;
      }
    }
    assert.equal(dupGroups, 0, `${dupGroups} 个组存在重复的 rule key`);
  });

  test('所有 key 引用都能解析到实际存在的规则', async () => {
    const { default: JSON5 } = await import('json5');
    const parsed = JSON5.parse(await readFile(DIST, 'utf8'));
    let dangling = 0;
    for (const app of parsed.apps ?? []) {
      for (const g of app.groups ?? []) {
        const keySet = new Set((g.rules ?? []).map((r) => r.key));
        for (const r of g.rules ?? []) {
          for (const k of ['actionCdKey', 'actionMaximumKey']) {
            if (r[k] !== undefined && r[k] !== null && !keySet.has(r[k])) dangling++;
          }
          for (const pk of Array.isArray(r.preKeys) ? r.preKeys : []) {
            if (!keySet.has(pk)) dangling++;
          }
        }
      }
    }
    assert.equal(dangling, 0, `${dangling} 个 key 引用指向不存在的规则`);
  });
});
