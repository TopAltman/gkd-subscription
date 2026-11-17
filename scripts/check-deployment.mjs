#!/usr/bin/env node
/**
 * 部署自检 —— 推送前跑一遍，确认「长期部署」这条链路是通的。
 *
 * ## 为什么需要它
 *
 * 订阅部署有一个很容易踩、且**表面上看不出来**的坑：
 *
 *   GKD 的订阅更新流程是：fetch checkUpdateUrl → 比对 version → 若变大则 fetch updateUrl
 *
 * 而 `updateUrl` / `checkUpdateUrl` 是**写在订阅文件内部**的。
 * 所以如果地址配错了：
 *   - 用户手动粘贴一个正确地址 → 订阅能加、能显示规则、能跳广告 → **一切看起来正常**
 *   - 但自动更新永远失败 → 社区源更新了、规则腐化了，你的订阅永远停在旧版本
 *
 * 这种故障要过好几天才暴露，而且很难联想到是地址配错。
 * 所以推送前必须验证「文件里写的地址」和「实际对外的地址」是同一个。
 *
 * ## 检查项
 *
 *   1. subscription.config.json 的 baseUrl 不是占位符
 *   2. baseUrl 能正常访问，gkd.json5 与 gkd.version.json5 都返回 200
 *   3. 线上 gkd.json5 内部的 updateUrl 与 baseUrl 一致（否则自动更新会指向别处）
 *   4. 线上版本号与本地一致
 *   5. 线上 gkd.json5 能被解析，且含 globalGroups（防止聚合器回退到丢字段的旧行为）
 *
 * 用法：
 *   node ./scripts/check-deployment.mjs
 *   node ./scripts/check-deployment.mjs --base-url https://xxx.github.io/yyy
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSON5 from 'json5';

import { SUBSCRIPTION_BASE_URL, OUTPUT_UPDATE_URL, checkDeployUrl } from './rules-aggregator/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const log = (...a) => console.log('[deploy-check]', ...a);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failures.push(m);
  console.error(`  ✗ ${m}`);
};

const failures = [];
const explicitBaseUrl = getArg('base-url', '');
const baseUrl = (explicitBaseUrl || SUBSCRIPTION_BASE_URL).replace(/\/+$/, '');

log(`检查部署地址: ${baseUrl}`);

/* ---------- 1. 地址本身 ---------- */
console.log('\n[1] 地址配置');
if (baseUrl.includes('<')) {
  bad(`baseUrl 仍是占位符: ${baseUrl}`);
  bad('请编辑 subscription.config.json 的 baseUrl，填入真实地址');
} else if (!/^https?:\/\//.test(baseUrl)) {
  bad(`baseUrl 必须以 http:// 或 https:// 开头: ${baseUrl}`);
} else {
  ok(`baseUrl 格式正确: ${baseUrl}`);
}
// 只有在「用配置文件的地址」时才提示配置问题；
// 显式传 --base-url 说明是有意临时覆盖，不该报配置文件的锅。
if (!explicitBaseUrl) {
  const urlProblem = checkDeployUrl();
  if (urlProblem) console.warn(`  (提示) ${urlProblem}`);
}

/* ---------- 2. 可访问性 ---------- */
console.log('\n[2] 网络可访问性');
const updateUrl = `${baseUrl}/gkd.json5`;
const checkUrl = `${baseUrl}/gkd.version.json5`;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: res.ok ? await res.text() : '' };
}

let onlineUpdate = null;
try {
  const r = await fetchText(updateUrl);
  if (r.status !== 200) {
    bad(`订阅文件不可访问: ${updateUrl} → HTTP ${r.status}`);
  } else {
    onlineUpdate = r.text;
    // 注意：JS 的 string.length 是字符数，不是字节数（中文一个字 3 字节）
    ok(`订阅文件可访问 (${r.text.length} 字符)`);
  }
} catch (e) {
  bad(`订阅文件无法访问: ${updateUrl} → ${e.message}`);
}

try {
  const r = await fetchText(checkUrl);
  if (r.status !== 200) {
    bad(`版本文件不可访问: ${checkUrl} → HTTP ${r.status}`);
  } else {
    ok(`版本文件可访问 (${r.text.trim()})`);
  }
} catch (e) {
  bad(`版本文件无法访问: ${checkUrl} → ${e.message}`);
}

/* ---------- 3. 线上文件内部地址是否自洽 ---------- */
console.log('\n[3] 线上文件内部地址自洽性');
if (onlineUpdate) {
  try {
    const parsed = JSON5.parse(onlineUpdate);
    const embeddedUpdate = parsed.updateUrl ?? '';
    const embeddedCheck = parsed.checkUpdateUrl ?? '';
    if (!embeddedUpdate) {
      bad('线上订阅文件缺少 updateUrl —— 客户端无法自动更新');
    } else if (!embeddedUpdate.startsWith(baseUrl)) {
      bad(
        `线上订阅文件内部的 updateUrl 与对外地址不一致\n` +
          `     对外: ${baseUrl}\n` +
          `     内部: ${embeddedUpdate}\n` +
          `     后果: 客户端能添加订阅（用户手动粘贴地址），但自动更新会失败。\n` +
          `     修法: 改 subscription.config.json 的 baseUrl 后重新构建并部署。`,
      );
    } else {
      ok(`内部 updateUrl 与对外地址一致: ${embeddedUpdate}`);
    }
    if (embeddedCheck && !embeddedCheck.startsWith(baseUrl)) {
      bad(`内部 checkUpdateUrl 与对外地址不一致: ${embeddedCheck}`);
    } else if (embeddedCheck) {
      ok(`内部 checkUpdateUrl 一致: ${embeddedCheck}`);
    }
  } catch (e) {
    bad(`线上订阅文件解析失败: ${e.message}`);
  }
}

/* ---------- 4. 版本一致性 ---------- */
console.log('\n[4] 版本一致性');
try {
  const localVersion = JSON5.parse(
    await readFile(path.join(ROOT, 'dist/gkd.version.json5'), 'utf8'),
  );
  const r = await fetchText(checkUrl);
  if (r.status === 200) {
    const onlineVersion = JSON5.parse(r.text);
    if (onlineVersion.version === localVersion.version) {
      ok(`线上线版本一致: ${localVersion.version}`);
    } else {
      bad(
        `线上线版本不一致: 线上=${onlineVersion.version} 本地=${localVersion.version}\n` +
          `     说明产物还没部署上去，或部署的是旧版本。`,
      );
    }
    if (onlineVersion.id !== localVersion.id) {
      bad(`订阅 id 不一致: 线上=${onlineVersion.id} 本地=${localVersion.id}`);
    } else {
      ok(`订阅 id 一致: ${localVersion.id}`);
    }
  }
} catch (e) {
  bad(`版本比对失败: ${e.message}`);
}

/* ---------- 5. 内容健康度 ---------- */
console.log('\n[5] 线上内容健康度');
if (onlineUpdate) {
  try {
    const parsed = JSON5.parse(onlineUpdate);
    const apps = parsed.apps?.length ?? 0;
    const groups = (parsed.apps ?? []).reduce((n, a) => n + (a.groups?.length ?? 0), 0);
    const globalGroups = parsed.globalGroups?.length ?? 0;
    if (apps > 0) ok(`线上订阅含 ${apps} 个 App / ${groups} 个组`);
    else bad('线上订阅没有任何 App');
    if (globalGroups > 0) {
      ok(`线上订阅含 ${globalGroups} 个全局组（通用规则）`);
    } else {
      bad(
        '线上订阅的 globalGroups 为空 —— 全局通用规则（覆盖数百 App）缺失。\n' +
          '     这通常是聚合器丢字段的旧行为，请用当前版本重新构建。',
      );
    }
  } catch {
    /* 已在第 3 步报过 */
  }
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(52));
if (failures.length === 0) {
  log(`全部通过 ✅  订阅地址可直接填进 GKD 客户端：${updateUrl}`);
  process.exit(0);
}
console.error(`发现 ${failures.length} 个问题：`);
failures.forEach((f, i) => console.error(`  ${i + 1}. ${f.split('\n')[0]}`));
process.exit(1);
