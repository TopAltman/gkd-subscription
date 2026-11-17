#!/usr/bin/env node
/**
 * 快照语料生成器
 *
 * ## 为什么需要它
 *
 * 校验器的核心安全承诺是「新规则必须在**同一个 App** 的非开屏界面上不命中」。
 * 但交接包里原本只有 2 个手写快照 —— 一个正样本、一个负样本，且分属不同 App。
 * 语料不足的直接后果是：安全闸门**没有判别力**。
 *   - 任何 `text*="跳过"` 这类宽松选择器都能通过（因为负样本里没有同 App 的诱饵）
 *   - 校验器退化成只查语法，负样本检查形同虚设
 *
 * 而 ROADMAP 里 P4 的验收标准是「正样本覆盖 ≥ 50 个主流 App 的开屏页，
 * 负样本覆盖 ≥ 200 个界面」。人工手写 250 棵树不现实，也不易维护。
 *
 * ## 本生成器的思路
 *
 * 用**界面模板**而不是手写树：
 *   每个 App 模板定义一套「开屏广告页 + 非开屏页」的结构，
 *   非开屏页里刻意放置**语义诱饵** —— 长得像跳过按钮、但不是广告的控件：
 *     - 「跳过引导」（新手教程页）
 *     - 「跳过广告」（App 内部视频播放器的插播广告，跟开屏广告无关）
 *     - 「跳过不兼容项目」（设置页）
 *     - 「跳过此步」（表单流程页）
 *
 * 这样一条宽松规则（`[text*="跳过"]`）会被同 App 的诱饵页拦下，
 * 而一条精确规则（`[id="com.x:id/skip_btn"]`）能通过 ——
 * 这正是校验器需要证明的判别力。
 *
 * 生成的快照结构与 GKD 上游 `MatchSimulatedNode` 一致
 * （name + attributes + children），可直接被校验器的 ReplayAdapter 消费。
 *
 * 用法：
 *   node ./scripts/snapshot-corpus/generate-corpus.mjs [--out fixtures/snapshots] [--apps 60]
 */
import { mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const OUT_DIR = path.resolve(ROOT, getArg('out', 'fixtures/snapshots'));
const APP_COUNT = Number(getArg('apps', 60));

/* ------------------------------------------------------------------ */
/* 节点构造辅助                                                        */
/* ------------------------------------------------------------------ */

const node = (name, attributes = {}, children = []) => ({
  name,
  attributes,
  children,
});

const FRAME = 'android.widget.FrameLayout';
const LINEAR = 'android.widget.LinearLayout';
const RELATIVE = 'android.widget.RelativeLayout';
const TEXT = 'android.widget.TextView';
const BUTTON = 'android.widget.Button';
const IMAGE = 'android.widget.ImageView';
const WEB = 'android.webkit.WebView';

/**
 * 一棵开屏广告页。
 *
 * @param {string} pkg  App 包名
 * @param {object} style 按钮风格，决定跳过控件的形态
 */
function splashPage(pkg, style) {
  const skipId = `${pkg}:id/skip_btn`;
  const skipTextId = `${pkg}:id/skip_text`;
  const counter = `${pkg}:id/count_down`;

  // 形态 A：跳过按钮是 ImageView，文字在旁边的 TextView（最常见）
  if (style === 'image') {
    return node(FRAME, { visibleToUser: true, clickable: false }, [
      node(IMAGE, { id: `${pkg}:id/splash_ad_image`, visibleToUser: true }, []),
      node(TEXT, { id: counter, text: '5', visibleToUser: true }, []),
      node(IMAGE, { id: skipId, clickable: true, visibleToUser: true }, []),
      node(TEXT, { id: skipTextId, text: '跳过', visibleToUser: true }, []),
    ]);
  }

  // 形态 B：跳过是带文字的 TextView，本身可点
  if (style === 'text') {
    return node(FRAME, { visibleToUser: true, clickable: false }, [
      node(IMAGE, { id: `${pkg}:id/splash_ad_image`, visibleToUser: true }, []),
      node(TEXT, { id: counter, text: '5', visibleToUser: true }, []),
      node(TEXT, { id: skipId, text: '跳过 5', clickable: true, visibleToUser: true }, []),
    ]);
  }

  // 形态 C：跳过按钮在容器里，文案是「跳过广告」
  if (style === 'adword') {
    return node(RELATIVE, { visibleToUser: true, clickable: false }, [
      node(IMAGE, { id: `${pkg}:id/splash_ad_image`, visibleToUser: true }, []),
      node(LINEAR, { id: `${pkg}:id/skip_container`, clickable: true, visibleToUser: true }, [
        node(TEXT, { id: skipTextId, text: '跳过广告', visibleToUser: true }, []),
        node(TEXT, { id: counter, text: '5', visibleToUser: true }, []),
      ]),
    ]);
  }

  // 形态 D：desc 承载文案（无 text），常见于图片按钮
  return node(FRAME, { visibleToUser: true, clickable: false }, [
    node(IMAGE, { id: `${pkg}:id/splash_ad_image`, visibleToUser: true }, []),
    node(IMAGE, {
      id: skipId,
      desc: '跳过广告',
      clickable: true,
      visibleToUser: true,
    }, []),
  ]);
}

/**
 * 同一 App 的非开屏页面集合 —— 每个都带「语义诱饵」。
 *
 * 这些诱饵是校验器的判别力来源：
 * 一条 `[text*="跳过"]` 会命中它们 → 被判误触 → 拦下。
 */
function decoyPages(pkg) {
  return [
    // ① 新手教程页：「跳过引导」按钮
    {
      kind: 'negative',
      activityId: `${pkg}.GuideActivity`,
      tree: node(FRAME, { visibleToUser: true, clickable: false }, [
        node(IMAGE, { id: `${pkg}:id/guide_image`, visibleToUser: true }, []),
        node(TEXT, { id: `${pkg}:id/guide_title`, text: '欢迎使用', visibleToUser: true }, []),
        node(BUTTON, {
          id: `${pkg}:id/guide_skip`,
          text: '跳过引导',
          clickable: true,
          visibleToUser: true,
        }, []),
      ]),
    },
    // ② App 内视频播放器：也有「跳过广告」，但这是插播广告不是开屏
    {
      kind: 'negative',
      activityId: `${pkg}.PlayerActivity`,
      tree: node(FRAME, { visibleToUser: true, clickable: false }, [
        node(VIDEO_PLACEHOLDER, { id: `${pkg}:id/video_surface`, visibleToUser: true }, []),
        node(TEXT, { id: `${pkg}:id/video_title`, text: '第 3 集 精彩继续', visibleToUser: true }, []),
        node(TEXT, {
          id: `${pkg}:id/video_skip_ad`,
          text: '跳过广告',
          clickable: true,
          visibleToUser: true,
        }, []),
        node(TEXT, { id: `${pkg}:id/video_danmaku`, text: '前排出售瓜子饮料', visibleToUser: true }, []),
      ]),
    },
    // ③ 设置页：「跳过不兼容项目」—— 与开屏广告毫无关系
    {
      kind: 'negative',
      activityId: `${pkg}.SettingsActivity`,
      tree: node(LINEAR, { visibleToUser: true, clickable: false }, [
        node(TEXT, { id: `${pkg}:id/settings_title`, text: '设置', visibleToUser: true }, []),
        node(TEXT, { id: `${pkg}:id/settings_account`, text: '已登录：example_user', visibleToUser: true }, []),
        node(BUTTON, {
          id: `${pkg}:id/settings_skip_incompatible`,
          text: '跳过不兼容项目',
          clickable: true,
          visibleToUser: true,
        }, []),
        node(TEXT, { id: `${pkg}:id/settings_version`, text: '版本 8.2.1', visibleToUser: true }, []),
      ]),
    },
    // ④ 表单流程页：「跳过此步」
    {
      kind: 'negative',
      activityId: `${pkg}.FormActivity`,
      tree: node(LINEAR, { visibleToUser: true, clickable: false }, [
        node(TEXT, { id: `${pkg}:id/form_title`, text: '完善资料', visibleToUser: true }, []),
        node(TEXT, { id: `${pkg}:id/form_phone`, text: '请输入手机号', visibleToUser: true }, []),
        node(TEXT, {
          id: `${pkg}:id/form_skip_step`,
          text: '跳过此步',
          clickable: true,
          visibleToUser: true,
        }, []),
        node(BUTTON, { id: `${pkg}:id/form_submit`, text: '提交', clickable: true, visibleToUser: true }, []),
      ]),
    },
    // ⑤ 首页信息流：含「跳过」字样的非可点文案（测可点性判定）
    {
      kind: 'negative',
      activityId: `${pkg}.MainActivity`,
      tree: node(LINEAR, { visibleToUser: true, clickable: false }, [
        node(TEXT, { id: `${pkg}:id/main_title`, text: '首页', visibleToUser: true }, []),
        node(TEXT, {
          id: `${pkg}:id/main_banner_text`,
          text: '点击跳过广告可获得更多奖励',
          clickable: false,
          visibleToUser: true,
        }, []),
        node(TEXT, { id: `${pkg}:id/main_feed_1`, text: '今日热点：某某宣布新计划', visibleToUser: true }, []),
        node(TEXT, { id: `${pkg}:id/main_feed_2`, text: '热门评论精选', visibleToUser: true }, []),
      ]),
    },
  ];
}

// 视频控件占位（Android 没有公开的 VideoView 类名在快照里常见为 SurfaceView）
const VIDEO_PLACEHOLDER = 'android.view.SurfaceView';

/* ------------------------------------------------------------------ */
/* App 名单                                                            */
/* ------------------------------------------------------------------ */

/**
 * App 名单。用真实的国内主流 App 包名，这样语料贴近真实分布。
 * 名字只用于生成合成快照，不含任何真实数据。
 */
const APPS = [
  ['com.tencent.mm', '微信'],
  ['com.tencent.mobileqq', 'QQ'],
  ['com.sina.weibo', '微博'],
  ['com.xingin.xhs', '小红书'],
  ['com.ss.android.ugc.aweme', '抖音'],
  ['com.ss.android.ugc.aweme.lite', '抖音极速版'],
  ['com.ss.android.article.video', '西瓜视频'],
  ['com.ss.android.article.news', '今日头条'],
  ['com.alibaba.android.rimet', '钉钉'],
  ['com.tencent.qqlive', '腾讯视频'],
  ['com.qiyi.video', '爱奇艺'],
  ['com.youku.phone', '优酷视频'],
  ['com.hunantv.imera.activity', '芒果TV'],
  ['com.netease.cloudmusic', '网易云音乐'],
  ['com.tencent.qqmusic', 'QQ音乐'],
  ['com.kugou.android', '酷狗音乐'],
  ['com.eg.android.AlipayGphone', '支付宝'],
  ['com.tencent.mm.pay', '微信支付'],
  ['com.unionpay', '云闪付'],
  ['com.jd.jrapp', '京东金融'],
  ['com.taobao.taobao', '淘宝'],
  ['com.tmall.wireless', '天猫'],
  ['com.jingdong.app.mall', '京东'],
  ['com.xunmeng.pinduoduo', '拼多多'],
  ['com.sankuai.meituan', '美团'],
  ['me.ele', '饿了么'],
  ['com.dianping.v1', '大众点评'],
  ['com.tencent.map', '腾讯地图'],
  ['com.autonavi.minimap', '高德地图'],
  ['com.baidu.BaiduMap', '百度地图'],
  ['com.tencent.qqmail', 'QQ邮箱'],
  ['com.netease.mail', '网易邮箱大师'],
  ['com.tencent.tmgp.sgame', '王者荣耀'],
  ['com.tencent.tmgp.pubgmhd', '和平精英'],
  ['com.netease.mc', '我的世界'],
  ['com.miHoYo.Yuanshen', '原神'],
  ['com.miHoYo.hkrpg', '崩坏：星穹铁道'],
  ['com.probe.zhiliao.musically', 'TikTok'],
  ['com.zhiliaoapp.musically', 'TikTok'],
  ['com.lemon.lv', '剪映'],
  ['com.ss.android.lite', '快影'],
  ['com.sensetime.megvii', '相机'],
  ['com.autonavi.amapauto', '高德打车'],
  ['com.didi.es.psngr', '滴滴出行'],
  ['com.Qunar', '去哪儿旅行'],
  ['com.ctrip.ctripstudent', '携程旅行'],
  ['com.taobao.idlefish', '闲鱼'],
  ['com.achievo.vipshop', '唯品会'],
  ['com.suning.mobile.ebuy', '苏宁易购'],
  ['com.jd.jdlite', '京东极速版'],
  ['com.xunmeng.duapp', '得物'],
  ['com.ss.android.homed', '房产'],
  ['com.zhuanzhuan.hunter', '转转'],
  ['com.wuba', '58同城'],
  ['com.anjuke.android.app', '安居客'],
  ['com.zhaopin.social', 'BOSS直聘'],
  ['com.hpbr.bosszhipin', 'BOSS直聘'],
  ['com.tencent.qqlivepad', '腾讯视频Pad'],
  ['com.bilibili.app.in', '哔哩哔哩'],
  ['com.bilibili.bilibili', '哔哩哔哩HD'],
  ['com.yy.yyapp', '虎牙直播'],
  ['com.douyu.module', '斗鱼'],
  ['com.zhihu.android', '知乎'],
  ['com.ss.android.lark', '飞书'],
];

const STYLES = ['image', 'text', 'adword', 'desc'];

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

/**
 * 为一个 App 生成一整套快照。
 * @returns {Array<{file:string, content:string}>}
 */
function buildAppSnapshots(pkg, appName, index) {
  const style = STYLES[index % STYLES.length];
  const out = [];

  // 正样本：开屏广告页
  out.push({
    file: `pos-${pkg}.json`,
    content: {
      appId: pkg,
      appName,
      activityId: `${pkg}.SplashActivity`,
      kind: 'positive',
      expectText: '跳过',
      expect: { text: '跳过' },
      tree: splashPage(pkg, style),
    },
  });

  // 负样本：同 App 的非开屏页
  for (const p of decoyPages(pkg)) {
    out.push({
      file: `neg-${pkg}-${p.activityId.split('.').pop()}.json`,
      content: {
        appId: pkg,
        appName,
        activityId: p.activityId,
        kind: 'negative',
        tree: p.tree,
      },
    });
  }

  return out;
}

async function main() {
  console.log(`[corpus] 输出目录: ${OUT_DIR}`);
  console.log(`[corpus] App 数量: ${APP_COUNT}（名单 ${APPS.length} 个，循环取用）`);

  // 保留手工夹具（demo-*），它们是自检用例，不覆盖
  const keep = [];
  if (existsSync(OUT_DIR)) {
    for (const f of await readdir(OUT_DIR)) {
      if (f.startsWith('demo-')) keep.push(f);
    }
  }

  // 清理旧生成的语料（只删本生成器产出的 pos-/neg- 前缀文件，手工夹具不受影响）
  for (const f of await readdir(OUT_DIR).catch(() => [])) {
    if (f.startsWith('pos-') || f.startsWith('neg-')) {
      await unlink(path.join(OUT_DIR, f)).catch(() => {});
    }
  }

  await mkdir(OUT_DIR, { recursive: true });

  let posCount = 0;
  let negCount = 0;
  const written = [];
  // 按包名去重，避免同一 App 生成两次（文件名相同会互相覆盖，统计也对不上）
  const picked = [];
  const seenPkg = new Set();
  for (let i = 0; picked.length < APP_COUNT && i < APPS.length * 4; i++) {
    const entry = APPS[i % APPS.length];
    if (seenPkg.has(entry[0])) continue;
    seenPkg.add(entry[0]);
    picked.push(entry);
  }
  for (let i = 0; i < picked.length; i++) {
    const [pkg, appName] = picked[i];
    for (const snap of buildAppSnapshots(pkg, appName, i)) {
      await writeFile(path.join(OUT_DIR, snap.file), `${JSON.stringify(snap.content, null, 2)}\n`, 'utf8');
      written.push(snap.file);
      if (snap.content.kind === 'positive') posCount++;
      else negCount++;
    }
  }

  console.log(`[corpus] 已生成 ${written.length} 个快照：正样本 ${posCount} / 负样本 ${negCount}`);
  console.log(`[corpus] 保留的手工夹具: ${keep.length > 0 ? keep.join(', ') : '无'}`);
}

main().catch((e) => {
  console.error('[corpus][fatal]', e);
  process.exit(1);
});
