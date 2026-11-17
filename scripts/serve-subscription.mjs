#!/usr/bin/env node
/**
 * 订阅文件静态服务器（局域网自测用）。
 *
 * ## 用途
 *
 * 手机要能订阅到本机产出的聚合规则，需要一个手机能访问到的 HTTP 地址。
 * 没有 GitHub 仓库时，用这个脚本把 dist/ 暴露到局域网即可：
 *
 *   node ./scripts/serve-subscription.mjs --port 8788
 *
 * 然后在 GKD 客户端「订阅 → +」里填：
 *
 *   http://<本机局域网IP>:8788/dist/gkd.json5
 *
 * 注意：订阅文件里的 updateUrl / checkUpdateUrl 是**生成时写入**的，
 * 所以生成产物时要用同一个地址：
 *
 *   SUBSCRIPTION_BASE_URL=http://<本机局域网IP>:8788/dist \\
 *     node ./scripts/rules-aggregator/aggregate.mjs
 *
 * ## 安全
 *
 * 只服务 dist/ 目录下的文件，不提供目录浏览，不接受任意路径。
 * GKD 的网络安全配置允许明文 HTTP（`cleartextTrafficPermitted="true"`），
 * 所以局域网内用 http:// 直接订阅没问题。
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(getArg('port', 8788));
const HOST = getArg('host', '0.0.0.0');

const MIME = {
  '.json5': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const log = (...a) => console.log('[serve]', ...a);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // 只允许 dist/ 下的文件
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel.startsWith('dist/')) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('仅提供 dist/ 下的文件');
      return;
    }
    const filePath = path.resolve(ROOT, rel);
    if (!filePath.startsWith(path.join(ROOT, 'dist'))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('非法路径');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('未找到');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'content-length': info.size,
      // 订阅更新要能及时生效，不缓存
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
    log(`200 ${rel} (${info.size} bytes)`);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e.message));
  }
});

server.listen(PORT, HOST, () => {
  log(`订阅服务已启动 http://${HOST}:${PORT}/dist/gkd.json5`);
  log('把上面的地址填到 GKD 客户端「订阅 → +」');
});
