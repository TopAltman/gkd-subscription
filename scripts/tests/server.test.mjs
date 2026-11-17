#!/usr/bin/env node
/**
 * 服务端 HTTP 接口的端到端测试。
 *
 * 覆盖交接文档里声称「已跑通」但实际上没有测试保护的那些行为：
 *   - 漏跳识别：含跳过按钮的树 → accepted:true
 *   - 兄弟文案识别：可点 ImageView + 旁边有「跳过」TextView（最常见的真实结构）
 *   - 拒绝图片：含图片字段 → 400
 *   - 不误拒图片：desc 含 "image" 的正常树 → 必须被接受（早期实现会误拒）
 *   - 脱敏：手机号等敏感文案被剥离
 *   - 鉴权：配置 AUTH_TOKEN 后无凭据 → 401
 *   - 限流：超量 → 429
 *   - 体积校验：超大/超深树 → 413
 *
 * 用法：node --test scripts/tests/server.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../server/server.mjs',
);

/**
 * 启动一个服务端实例。
 * @returns {Promise<{base:string, stop:()=>void}>}
 */
function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/([\d.]+):(\d+)/);
      if (m && !settled) {
        settled = true;
        resolve({
          base: `http://${m[1]}:${m[2]}`,
          stop: () => proc.kill(),
        });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`服务端退出 code=${code}: ${buf}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('服务端启动超时'));
      }
    }, 15_000);
  });
}

async function post(base, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json };
}

/** 一棵典型的开屏广告树：含可点击的「跳过」节点。 */
const splashTree = {
  name: 'android.widget.FrameLayout',
  attributes: { visibleToUser: true, clickable: false },
  children: [
    {
      name: 'android.widget.TextView',
      attributes: { text: '跳过 5', clickable: true, visibleToUser: true },
      children: [],
    },
  ],
};

/**
 * 最常见的真实结构：可点的是 ImageView（自身无文字），
 * 「跳过」两个字在旁边的 TextView 上。
 */
const imageButtonSplashTree = {
  name: 'android.widget.FrameLayout',
  attributes: { visibleToUser: true, clickable: false },
  children: [
    {
      name: 'android.widget.ImageView',
      attributes: { id: 'com.demo:id/splash', visibleToUser: true },
      children: [],
    },
    {
      name: 'android.widget.ImageView',
      attributes: { id: 'com.demo:id/skip_btn', clickable: true, visibleToUser: true },
      children: [],
    },
    {
      name: 'android.widget.TextView',
      attributes: { id: 'com.demo:id/skip_text', text: '跳过', visibleToUser: true },
      children: [],
    },
  ],
};

describe('服务端接口', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv?.stop());

  test('/health 返回 ok', async () => {
    const h = await fetch(`${srv.base}/health`).then((r) => r.json());
    assert.equal(h.ok, true);
    assert.equal(h.auth, 'disabled');
  });

  test('含跳过按钮 → accepted:true', async () => {
    const r = await post(srv.base, '/report', { appId: 'com.demo', tree: splashTree });
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, true);
    assert.equal(typeof r.json.reportId, 'string');
  });

  test('可点 ImageView + 兄弟「跳过」文案 → 也能识别为漏跳', async () => {
    const r = await post(srv.base, '/report', {
      appId: 'com.demo',
      tree: imageButtonSplashTree,
    });
    assert.equal(r.json.accepted, true, '兄弟文案结构未被识别为漏跳');
  });

  test('无跳过按钮 → accepted:false', async () => {
    const r = await post(srv.base, '/report', {
      appId: 'com.demo',
      tree: {
        name: 'android.widget.LinearLayout',
        attributes: {},
        children: [
          {
            name: 'android.widget.TextView',
            attributes: { text: '首页', clickable: true },
            children: [],
          },
        ],
      },
    });
    assert.equal(r.json.accepted, false);
  });

  test('缺少 tree → 400', async () => {
    const r = await post(srv.base, '/report', { appId: 'com.demo' });
    assert.equal(r.status, 400);
  });

  test('缺少 appId → 400', async () => {
    const r = await post(srv.base, '/report', { tree: splashTree });
    assert.equal(r.status, 400);
  });

  test('含 base64 字段 → 400 且指出字段名', async () => {
    const r = await post(srv.base, '/report', {
      appId: 'com.demo',
      tree: { name: 'x', attributes: { base64: 'AAAA' } },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'tree.attributes.base64');
  });

  test('含 screenshot 字段 → 400', async () => {
    const r = await post(srv.base, '/report', {
      appId: 'com.demo',
      tree: { name: 'x', attributes: { screenshot: 'abc' } },
    });
    assert.equal(r.status, 400);
  });

  test('desc 含 "image" 的正常树不被误拒', async () => {
    const r = await post(srv.base, '/report', {
      appId: 'com.demo',
      tree: {
        name: 'android.widget.ImageView',
        attributes: { id: 'com.demo:id/cover_image', desc: 'View image', clickable: false },
        children: [
          { name: 'android.widget.TextView', attributes: { text: '跳过', clickable: true } },
        ],
      },
    });
    assert.equal(r.status, 200, `status=${r.status}`);
    assert.equal(r.json.accepted, true);
  });

  test('超深树 → 413', async () => {
    let deep = { name: 'leaf', attributes: {}, children: [] };
    for (let i = 0; i < 80; i++) deep = { name: 'n', attributes: {}, children: [deep] };
    const r = await post(srv.base, '/report', { appId: 'com.demo', tree: deep });
    assert.equal(r.status, 413);
  });

  test('超大树 → 413', async () => {
    const many = {
      name: 'root',
      attributes: {},
      children: Array.from({ length: 25000 }, () => ({
        name: 'n',
        attributes: {},
        children: [],
      })),
    };
    const r = await post(srv.base, '/report', { appId: 'com.demo', tree: many });
    assert.equal(r.status, 413);
  });

  test('手机号等敏感文案不出现在 /pending 返回中', async () => {
    const r = await post(srv.base, '/report', {
      appId: 'com.demo.secret',
      tree: {
        name: 'android.widget.TextView',
        attributes: { text: '我的手机号是13800138000', clickable: false },
        children: [
          { name: 'android.widget.TextView', attributes: { text: '跳过', clickable: true } },
        ],
      },
    });
    assert.equal(r.status, 200);
    const pending = await fetch(`${srv.base}/pending`).then((res) => res.json());
    const raw = JSON.stringify(pending);
    assert.ok(!raw.includes('13800138000'), '手机号出现在返回内容里');
    assert.ok(raw.includes('跳过'), '跳过候选信息丢失');
  });
});

describe('服务端鉴权', () => {
  let srv;
  before(async () => {
    srv = await startServer({ AUTH_TOKEN: 'secret-token-123' });
  });
  after(() => srv?.stop());

  test('/health 报告已启用鉴权', async () => {
    const h = await fetch(`${srv.base}/health`).then((r) => r.json());
    assert.equal(h.auth, 'enabled');
  });

  test('无凭据 → 401', async () => {
    const r = await post(srv.base, '/report', { appId: 'com.demo', tree: splashTree });
    assert.equal(r.status, 401);
  });

  test('错误凭据 → 403', async () => {
    const r = await post(
      srv.base,
      '/report',
      { appId: 'com.demo', tree: splashTree },
      { authorization: 'Bearer wrong-token' },
    );
    assert.equal(r.status, 403);
  });

  test('正确凭据 → 200', async () => {
    const r = await post(
      srv.base,
      '/report',
      { appId: 'com.demo', tree: splashTree },
      { authorization: 'Bearer secret-token-123' },
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, true);
  });
});

describe('服务端限流', () => {
  let srv;
  before(async () => {
    srv = await startServer({ RATE_LIMIT_PER_MIN: '3' });
  });
  after(() => srv?.stop());

  test('超量请求被限流', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(srv.base, '/report', { appId: 'com.demo', tree: splashTree });
      codes.push(r.status);
    }
    assert.ok(codes.slice(0, 3).every((c) => c === 200), JSON.stringify(codes));
    assert.ok(codes.slice(3).every((c) => c === 429), JSON.stringify(codes));
  });
});
