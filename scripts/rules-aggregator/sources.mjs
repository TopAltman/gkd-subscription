/**
 * 社区订阅源清单
 *
 * 维护说明：
 *  1. 本清单是「规则供给侧」的唯一事实源。任何一个源 404/停更，聚合器会自动跳过并记录，
 *     不会导致整体构建失败 —— 这正是自建聚合层相对于直接订阅单个社区源的核心价值。
 *  2. `weight` 表示该源在本项目里的可信度权重。合并去重时，同一条规则被多个源覆盖时
 *     取 weight 高的源的首选版本。历史经验：官方默认订阅(gkd-kit/subscription)已于 2024-04
 *     归档停更，不要再加回来。
 *  3. `mirrors` 是同一份内容的多个镜像地址，按顺序尝试。raw.githubusercontent.com 在国内
 *     不稳定，jsDelivr / npmmirror 作为兜底。
 *  4. 新增源前请先用 scripts/rules-aggregator/probe-sources.mjs 探测可用性。
 *
 * 已实测可用性（2026-11-16，国内网络环境）：
 *   Lin-arm    ✓ 1004 apps / 1.27 MB
 *   AIsouler   ✓  886 apps / 1.01 MB   （星最多，但 2026-02 后更新放缓）
 *   Adpro      ✓  678 apps / 644 KB
 *   MengNian   ✓  285 apps / 500 KB
 *   YaChengMu  ✓   69 apps / 305 KB
 *   ganlinte   ✗ 404（npmmirror 路径已变更，raw 直连待重测）
 *   Mrlc       ✗ 404（同上）
 *   114514     ✗ 403（npmmirror 拒绝）
 */
import { readFileSync } from 'node:fs';
import JSON5 from 'json5';

export const SOURCES = [
  {
    id: 'lin-arm',
    name: 'Lin-arm/GKD_subscription',
    weight: 90,
    mirrors: [
      'https://cdn.jsdelivr.net/gh/Lin-arm/GKD_subscription@main/dist/gkd.json5',
      'https://raw.githubusercontent.com/Lin-arm/GKD_subscription/main/dist/gkd.json5',
    ],
  },
  {
    id: 'aisouler',
    name: 'AIsouler/GKD_subscription',
    weight: 80,
    mirrors: [
      'https://registry.npmmirror.com/@aisouler/gkd_subscription/latest/files/dist/AIsouler_gkd.json5',
      'https://raw.githubusercontent.com/AIsouler/GKD_subscription/main/dist/AIsouler_gkd.json5',
    ],
  },
  {
    id: 'adpro',
    name: 'Adpro-Team/GKD_subscription',
    weight: 75,
    mirrors: [
      'https://registry.npmmirror.com/@adpro/gkd_subscription/latest/files/dist/Adpro_gkd.json5',
      'https://raw.githubusercontent.com/Adpro-Team/GKD_subscription/main/dist/Adpro_gkd.json5',
    ],
  },
  {
    id: 'mengnian',
    name: 'MengNianxiaoyao/gkd-subscription',
    weight: 70,
    mirrors: [
      'https://registry.npmmirror.com/gkd-subscription/latest/files/dist/gkd.json5',
      'https://registry.npmmirror.com/gkd-subscription/2.0.68/files/dist/gkd.json5',
    ],
  },
  {
    id: 'yachengmu',
    name: 'YaChengMu/gkd_subscription_min',
    weight: 60,
    mirrors: [
      'https://cdn.jsdelivr.net/gh/YaChengMu/gkd_subscription_min@main/dist/gkd.json5',
      'https://raw.githubusercontent.com/YaChengMu/gkd_subscription_min/main/dist/gkd.json5',
    ],
  },
];

/**
 * 本项目自建规则（LLM 自动修复产出）所在的目录。
 * 聚合器会把这里的规则以最高优先级合并进最终产物。
 */
export const LOCAL_RULES_DIR = './rules/local';

/**
 * 部署配置：从仓库根目录的 subscription.config.json 读取。
 *
 * 为什么做成独立配置文件而不是写死在代码里：
 *   updateUrl / checkUpdateUrl 会**写进订阅文件内部**，客户端靠它们做自动更新。
 *   长期部署时这两个地址必须指向真实的、手机能访问到的地址。
 *   放进版本控制的配置文件后，改地址就是在 GitHub 网页上改一行 JSON，
 *   不需要动源码、不需要配置 CI 密钥、也不会因为漏改某处代码而产出坏订阅。
 *
 * 优先级：环境变量 > subscription.config.json > 内置占位符
 */
const CONFIG_PATH = new URL('../../subscription.config.json', import.meta.url);

function loadDeployConfig() {
  try {
    // 允许 _comment / _howto 这类注释字段，用 JSON5 解析更宽容
    return JSON5.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

const deployConfig = loadDeployConfig();

/**
 * 最终订阅文件的 id。必须是一个足够大的、不与任何社区源冲突的随机整数。
 * GKD 约定：id 不同的订阅更新会失败，所以 id 必须稳定且唯一。
 */
export const OUTPUT_SUBSCRIPTION_ID = Number(
  process.env.SUBSCRIPTION_ID ?? deployConfig.subscriptionId ?? 90210,
);

/**
 * 客户端拉取地址（基地址）。
 *
 * 优先级：
 *   1. 环境变量 SUBSCRIPTION_BASE_URL —— 临时换地址用（局域网自测、换域名）
 *   2. subscription.config.json 的 baseUrl —— 长期部署的正常路径
 *   3. 内置占位符 —— 未配置时由 checkDeployUrl() 明确报错
 *
 * 局域网自测：
 *   SUBSCRIPTION_BASE_URL=http://192.168.1.10:8788/dist npm run aggregate
 */
const PLACEHOLDER_BASE_URL = 'https://raw.githubusercontent.com/<your-account>/<your-repo>/main/dist';

export const SUBSCRIPTION_BASE_URL = (
  process.env.SUBSCRIPTION_BASE_URL ??
  deployConfig.baseUrl ??
  PLACEHOLDER_BASE_URL
).replace(/\/+$/, '');

export const OUTPUT_UPDATE_URL = `${SUBSCRIPTION_BASE_URL}/gkd.json5`;
export const OUTPUT_CHECK_UPDATE_URL = `${SUBSCRIPTION_BASE_URL}/gkd.version.json5`;

/**
 * 检查部署地址是否还是占位符。
 *
 * 占位符地址会被原样写进订阅文件 —— 客户端首次添加订阅（用户手动粘贴真实地址）
 * 没问题，但**自动更新一定失败**，因为它跟着文件里的 updateUrl 走。
 * 这种错在表面上看不出来（订阅能加、能显示规则、能跳广告），
 * 只有过几天规则腐化了才发现，所以要在构建阶段就拦下来。
 *
 * @returns {string|null} 问题描述；没问题返回 null
 */
export function checkDeployUrl() {
  const url = SUBSCRIPTION_BASE_URL;
  if (url.includes('<')) {
    return (
      `订阅地址仍是占位符：${url}\n` +
      `请编辑 subscription.config.json 的 baseUrl（或设置环境变量 SUBSCRIPTION_BASE_URL），\n` +
      `填入手机能访问到的真实地址。否则客户端能添加订阅，但自动更新一定失败。`
    );
  }
  if (!/^https?:\/\//.test(url)) {
    return `订阅地址必须以 http:// 或 https:// 开头，当前是：${url}`;
  }
  return null;
}
