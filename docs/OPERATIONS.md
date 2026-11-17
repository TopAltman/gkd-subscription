# 部署与运维手册

## 一、整体拓扑

```
GitHub Actions ──▶ dist/gkd.json5 ──▶ jsDelivr / raw.githubusercontent
                                                │
                                                │ GKD 客户端 checkUpdateUrl 自动比对
                                                ▼
                                          手机上的 GKD
                                                │
                                          POST /report（漏跳快照）
                                                ▼
                                      自建服务端（Node，任意云主机）
                                                │
                                          POST /generate（可选，走 LLM）
                                                ▼
                                         rules/local/*.json5
                                                │
                                                └─▶ 被下一次聚合收进 dist
```

---

## 二、规则仓库部署

### 2.1 建仓

```bash
git init gkd-subscription
cd gkd-subscription
# 把 handoff/ 下的 scripts/ rules/ .github/ 等目录拷进来
```

### 2.2 修改源清单与输出地址

编辑 `scripts/rules-aggregator/sources.mjs`：

```js
export const OUTPUT_SUBSCRIPTION_ID = 90210;   // 换一个大的随机数，与社区源不冲突

export const OUTPUT_UPDATE_URL =
  'https://cdn.jsdelivr.net/gh/<你的账号>/<你的仓库>@main/dist/gkd.json5';
export const OUTPUT_CHECK_UPDATE_URL =
  'https://cdn.jsdelivr.net/gh/<你的账号>/<你的仓库>@main/dist/gkd.version.json5';
```

> **关于 CDN 选择**：
> - `raw.githubusercontent.com` — 更新及时，但国内访问不稳定
> - `cdn.jsdelivr.net` — 国内可访问，但有最长 24h 缓存延迟
> - `fastly.jsdelivr.net` — 备用
>
> 建议 `checkUpdateUrl` 用 jsDelivr（流量小、被缓存无所谓），
> `updateUrl` 也用 jsDelivr（规则更新慢一天可接受，换取稳定性）。
> 如果你愿意用付费 CDN（如又拍云、七牛），可以把 `updateUrl` 指向自己的域名，获得实时更新。

### 2.3 在 GKD 客户端里添加订阅

订阅 → 右下角「+」→ 粘贴上面的 `updateUrl` → 确认。

客户端会自动按 `checkUpdateUrl` 定期检查，**版本变大才更新**。

---

## 三、服务端部署

### 3.1 最小配置

```bash
# 需要 Node >= 22
export LLM_BASE_URL='https://api.deepseek.com/v1'   # 或其它 OpenAI 兼容接口
export LLM_API_KEY='sk-xxx'
export LLM_MODEL='deepseek-chat'
export PORT=8787
export RULES_DIR='./rules/local'
export SNAPSHOT_DIR='./fixtures/snapshots'

node server/server.mjs
```

### 3.2 接口说明

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回待处理队列数与 LLM 配置状态 |
| GET | `/pending` | 查看待处理的漏跳上报列表 |
| POST | `/report` | 端上上报漏跳快照。**只接受节点树，拒绝任何图片字段** |
| POST | `/generate` | 对指定 `reportId` 生成规则，走校验器，通过则写入 `rules/local/` |

### 3.3 部署形态建议

个人自用场景，最简方案：

- **GitHub Actions + 静态托管**：规则仓库的聚合与构建完全交给 Actions（免费）
- **服务端**：任意一台便宜云主机即可（1 核 512M 足够，因为请求量极低 —— 只在漏跳时才有请求）
- 或者：**用 Cloudflare Workers / Vercel Edge Functions** 跑服务端，省掉服务器维护

> 实际上，个人自用场景下**服务端甚至可以先不部署**。
> P1（规则仓库 + CI 聚合）已经解决了「规则更新很麻烦」这个核心痛点。
> 服务端是为 P3（自动修复）准备的，可以等快照库积累到一定规模后再上。

---

## 四、CI 配置说明

### 4.1 aggregate.yml（定时聚合）

- 频率：每 6 小时一次
- 步骤：探测源 → 聚合 → 校验自建规则 → 全量语法检查 → 提交产物
- **只有产物有变化才提交**，客户端因此不会收到无意义的更新

### 4.2 validate.yml（PR 把关）

自建规则变更合入主分支前，必须通过：
- `validate.mjs --all` — 目标快照命中 + 负样本不误触
- `check-syntax.mjs` — 全量选择器语法检查

### 4.3 需要开放的权限

GitHub 仓库 → Settings → Actions → General → Workflow permissions → **Read and write permissions**

否则 Actions 无法提交产物。

---

## 五、日常运维

### 5.1 监控什么

| 指标 | 怎么看 | 异常含义 |
|---|---|---|
| 源可用数 | `node scripts/rules-aggregator/probe-sources.mjs` | < 2 个说明供给侧有断供风险 |
| 产物版本号 | `cat dist/gkd.version.json5` | 长时间不变说明聚合任务挂了 |
| 语法错误率 | CI 日志 | 突然升高说明上游社区源改格式了 |
| 跨源冲突数 | 聚合日志 | 持续升高说明上游源之间开始打架 |
| 校验通过率 | validate.yml 日志 | 降低说明 LLM 生成质量下降或快照库需要扩充 |

### 5.2 常见故障处理

**症状：客户端提示订阅更新失败**
1. 检查 `dist/gkd.json5` 的 `id` 是否与客户端里的一致 —— **id 不一致会直接更新失败**
2. 检查 `version` 是否真的递增了
3. 检查 `updateUrl` / `checkUpdateUrl` 是否可匿名访问

**症状：规则不生效（跳不过广告）**
1. 确认客户端订阅的是你的地址，且版本已更新
2. 检查该 App 的规则组是否被手动禁用了
3. 用 GKD 的网页审查工具（`inspect.gkd.li`）抓快照，看选择器是否还能命中
4. 若选择器失效，说明上游 App 改版了 —— 这正是 P3 要自动解决的问题

**症状：某些 App 启动就闪退**
多半是该 App 检测到无障碍服务。在 GKD 设置里把该 App 加入「无障碍局部关闭」名单。

---

## 六、成本估算

| 项目 | 成本 | 说明 |
|---|---|---|
| GitHub Actions | 免费 | 公开仓库无限量；私有仓库每月 2000 分钟，本项目每月约 120 分钟 |
| 静态托管 | 免费 | jsDelivr / GitHub Pages 自带 |
| 云服务器（可选） | 约 10-30 元/月 | 1 核 512M 足够，个人自用可按量付费，用得极省 |
| LLM API | 约 0.5-3 元/月 | 只在漏跳时调用；每次约 2-4k tokens。**调用前有校验前置检查，不会为已有规则付费** |

> **降本关键**：服务端在调用 LLM 前应先检查「是否已有可用规则」。
> 本实现的 `validateRule` 逻辑天然支持这一点 —— 如果现有规则已能命中目标快照，
> 就不需要重新生成。
