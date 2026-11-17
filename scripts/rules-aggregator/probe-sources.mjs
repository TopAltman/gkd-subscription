#!/usr/bin/env node
/**
 * 社区源可用性探测
 *
 * 用途：定期检查 sources.mjs 里的源是否还活着，输出可用性报告。
 * 社区源随时可能改路径或停更（实测已有 3 个源 404/403），
 * 所以这个脚本应当定期跑，失效的源及时从 sources.mjs 里移除或换镜像。
 *
 * 用法：node scripts/rules-aggregator/probe-sources.mjs
 */
import JSON5 from 'json5';
import { SOURCES } from './sources.mjs';

const TIMEOUT_MS = 25000;

async function probe(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'gkd-skip-ad-aggregator/1.0' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    const j = JSON5.parse(text);
    return {
      ok: true,
      ms: Date.now() - t0,
      kb: Math.round(text.length / 1024),
      id: j.id,
      version: j.version,
      apps: Array.isArray(j.apps) ? j.apps.length : 0,
    };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

console.log('探测社区订阅源可用性\n');
const results = [];
for (const src of SOURCES) {
  let best = null;
  let bestUrl = null;
  let anyOk = false;
  for (const url of src.mirrors) {
    const r = await probe(url);
    if (r.ok) {
      anyOk = true;
      best = r;
      bestUrl = url;
      break; // 第一个可用镜像即可
    }
    best ??= r;
  }
  const status = anyOk ? '✓ 可用' : '✗ 不可用';
  console.log(`${status}  ${src.name} (id=${src.id})`);
  if (anyOk) {
    console.log(
      `        apps=${best.apps} version=${best.version} ${best.kb}KB ${best.ms}ms`,
    );
    console.log(`        ${bestUrl}`);
  } else {
    console.log(`        ${best?.error ?? '未知错误'}`);
    for (const url of src.mirrors) console.log(`        镜像: ${url}`);
  }
  results.push({ id: src.id, name: src.name, ok: anyOk });
}

const alive = results.filter((r) => r.ok).length;
console.log(`\n汇总：${alive}/${results.length} 个源可用`);
if (alive < 2) {
  console.error('警告：可用源少于 2 个，供给侧存在断供风险，请及时补充源清单。');
  process.exit(1);
}
