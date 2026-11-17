#!/usr/bin/env node
/**
 * 全量语法检查
 *
 * 对产物（或任意订阅文件）里的每一个选择器做编译校验，统计失败率。
 *
 * 这个脚本的价值在实测中被验证过：正是它发现了 550 条「matches 写成数组」
 * 的规则曾导致编译器崩溃（`a.a is not a function`）。这类问题如果不检查，
 * 会一路带到客户端才暴露。
 *
 * 用法：
 *   node scripts/rules-aggregator/check-syntax.mjs [file]
 *   默认检查 dist/gkd.json5
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';
import { Selector, SelectorCompileResult } from '@gkd-kit/selector';

const file = process.argv[2] ?? 'dist/gkd.json5';

if (!existsSync(file)) {
  console.error(`[check-syntax] 文件不存在: ${file}`);
  process.exit(1);
}

/** matches 可能是字符串，也可能是字符串数组，必须归一化。 */
const list = (m) =>
  Array.isArray(m) ? m.filter((x) => typeof x === 'string' && x.length) : typeof m === 'string' && m.length ? [m] : [];

let ruleCount = 0;
let selectorCount = 0;
let syntaxBad = 0;
let crashed = 0;
const badSamples = [];
const crashSamples = [];

const parsed = JSON5.parse(await readFile(file, 'utf8'));

for (const app of parsed.apps ?? []) {
  for (const group of app.groups ?? []) {
    for (const rule of group.rules ?? []) {
      ruleCount++;
      for (const src of list(rule.matches)) {
        selectorCount++;
        try {
          const r = Selector.compile(src);
          if (r instanceof SelectorCompileResult.Failure) {
            syntaxBad++;
            if (badSamples.length < 10) {
              badSamples.push(`${app.id}/${group.name}: ${src}\n      → ${r.message}`);
            }
          }
        } catch (e) {
          crashed++;
          if (crashSamples.length < 10) {
            crashSamples.push(`${app.id}/${group.name}: ${src}\n      → 崩溃: ${e.message}`);
          }
        }
      }
    }
  }
}

console.log(`[check-syntax] ${file}`);
console.log(`  规则条目 ${ruleCount} | 选择器 ${selectorCount}`);
console.log(`  语法错误 ${syntaxBad} | 编译崩溃 ${crashed}`);

if (badSamples.length) {
  console.log('\n语法错误样例：');
  badSamples.forEach((s) => console.log(`  ✗ ${s}`));
}
if (crashSamples.length) {
  console.log('\n崩溃样例（通常是 matches 数组被当成字符串处理）：');
  crashSamples.forEach((s) => console.log(`  💥 ${s}`));
}

const total = syntaxBad + crashed;
if (total > 0) {
  const rate = (total / selectorCount) * 100;
  console.error(`\n[check-syntax] 存在 ${total} 个无效选择器（${rate.toFixed(3)}%）`);
  // 小于 0.5% 时只警告不阻断：社区源偶有个别写法问题不应卡住整条流水线
  if (rate > 0.5) {
    console.error('[check-syntax] 失败率过高，终止。');
    process.exit(1);
  }
  console.warn('[check-syntax] 失败率在容忍范围内，继续。');
}
process.exit(0);
