# 变更记录 · 交接包接手后的修复与补全

> 基线：交接包 `跳广告自动修复流水线-交接包.tar.gz`（2026-11-16 导入）
> 本文记录**接手后实际发现并修复的问题**，每一条都附了复现方式或量化数据。

---

## 一、为什么交接包「已验证」的结论需要重新核对

交接包的 README 用「已验证的技术结论」表格给出了 6 条结论。逐条在真实环境复跑后，
**结论本身大多成立，但其中有 3 条的覆盖面比表述的窄**，另有 4 个未被发现的缺陷。
本节先说明核对结果，再逐条给出修复。

### 1.1 复跑基线

| 项目 | 交接包声称 | 实际复跑 | 结论 |
|---|---|---|---|
| 选择器引擎可脱离 Android 运行 | ✅ | ✅ 27 个导出 | 成立 |
| 聚合器合并 4 个源 | 1067 apps / 7835 规则 | 1066 apps / 7840 规则（5 源 + 本地规则） | 成立（源数量已从 4 增至 5） |
| 产物选择器语法正确 | 0 错误 | 7599 选择器 / 0 错误 / 0 崩溃 | 成立 |
| 校验器能拦截误触规则 | 好规则通过 / 坏规则被拦 | 通过 / 拦截 | **成立，但判别力来自 1 个负样本** |
| 服务端识别漏跳、拒绝带图上报 | ✅ | ✅ | 成立，但拒绝逻辑会误拒正常节点树 |
| 服务端脱敏剥离敏感文案 | ✅ | ✅ | 成立 |

---

## 二、已修复的缺陷

### 缺陷 1 · 聚合器丢弃 `globalGroups`（数据丢失，严重）

**现象**：产物里 `globalGroups: []`，而 5 个社区源各有 3~9 个全局组。

**为什么严重**：全局组是 GKD 里「不限 App 的通用规则」的载体。
实测社区源的「开屏广告-全局」覆盖 **300~515 个 App**，
是整份订阅里**命中率最高**的部分 —— 丢掉它等于丢掉了大半实际生效的规则，
而聚合器的日志里完全看不出异常（它照样报「合并完成」）。

**修复**：`scripts/rules-aggregator/aggregate.mjs` 新增 `flattenGlobalGroups()`，
按组名合并全局组，组内规则取并集去重，`apps` 白名单跨源取并集。

**验证**：产物从 `globalGroups: []` 变为 **12 个全局组 / 65 条规则**，
「开屏广告-全局」的 App 覆盖从单源 376 个提升到合并后 **515 个**。

---

### 缺陷 2 · 冲突检测跨 App 误报（噪声淹没信号）

**现象**：每次聚合都报「检测到 120 处冲突，其中跨源冲突 74 处，需人工确认」。

**根因**：`mergeSources()` 用一个**全局**的 `selector -> action` 映射表比较动作。
于是 A App 的 `[text="跳过"]`（click）和 B App 的 `[text="跳过"]`（clickCenter）被判为冲突 ——
但这两条规则**根本不会在同一个 App 里同时生效**，不存在「先执行哪个改变页面状态」的问题。

**量化**：修复前报 76 处（跨 App 比较口径）／真实冲突 8 处（同 App+同组口径），
**噪声比真实信号高一个数量级**，真正需要人工确认的冲突被埋没。

**修复**：作用域键改为 `App + 组名 + 选择器`。
另外引入**动作族**概念：`click` / `clickNode` / `clickCenter` 三者作用在同一节点上、
最终效果等价（上游 `click` 的实现是先试 `clickNode`、失败再回退 `clickCenter`），
属于写法差异而非冲突，不再计入。

**验证**：冲突数 **76 → 1**，且剩下这 1 处是真冲突
（`com.tencent.mm` 的「微信读书网页版扫码登录自动授权」组，lin-arm 说 `back`、adpro 说 `click`，
两者语义完全不同，确实需要人工判断）。

---

### 缺陷 3 · 合并后 rule `key` 重复，`preKeys` / `actionCdKey` 引用错位

**现象**：合并多个源到同一组后，组内规则的 `key` 大面积重复。

**为什么严重**：上游 `ResolvedRule.bindGroupRules()` 按 key 在**组内**查找兄弟规则：
- `preKeys` → 依赖的前置规则（用 `filter` 取**全部**匹配）
- `actionCdKey` → 共享冷却计数（用 `find` 取**第一个**匹配）
- `actionMaximumKey` → 共享执行次数上限

每个社区源的 key 都从 0 开始独立编号，合并后必然冲突。

**量化**：3727 个组里 **445 个组有重复 key**，**425 个组带 key 引用**（共 889 个引用）。
key 重复时，`preKeys` 会把无关规则也拉成依赖，`actionCdKey` 会命中错误的规则 ——
冷却与次数上限串到别的规则上。

**修复**：新增 `renumberRuleKeys()` —— 给组内规则重新分配唯一 key（0..n-1），
再用每个源自己的「原始 key → 指纹 → 新 key」映射把引用改写到新 key。

**验证**：重复 key 的组 **445 → 0**，889 个 key 引用**全部可解析，悬空引用 0**。

---

### 缺陷 4 · 组级字段被白名单过滤，静默改变匹配语义

**现象**：聚合器只搬运 7 个组级字段（`activityIds` / `matchTime` / `actionMaximum` /
`resetMatch` / `fastQuery` / `matchRoot` / `excludeActivityIds`）。

**被丢掉的字段**：`desc` / `enable` / `scopeKeys` / `order` / `forcedTime` / `priorityTime` /
`actionCd` / `actionDelay` / `matchDelay` / `actionCdKey` / `actionMaximumKey` /
`ignoreGlobalGroupMatch` / `versionCode` / `versionName` / `snapshotUrls` …

其中 `order` 决定组优先级、`forcedTime` 决定强匹配窗口、
`ignoreGlobalGroupMatch` 决定全局组是否被该 App 的组抑制 —— 丢字段等于**行为静默改变**。

**修复**：改为整组透传（只剔除内部字段 `_src` / `_weight` / `key` / `rules`）。
`categories` 同理 —— 原本也被写成空数组，现按名称合并。

**验证**：产物中 636 个 App 带 `desc`、257 个带 `order`、21 个带 `forcedTime`、
15 个带 `ignoreGlobalGroupMatch`。

---

### 缺陷 5 · 校验器的负样本语义与 GKD 实际作用域不符

**现象**：校验器把所有快照一股脑当负样本。

**根因**：GKD 的 App 级规则是**按包名严格作用域**执行的 —— 上游 `AppRule.matchActivity()` 里
`if (appId != app.id) return false`。也就是说，com.foo 的规则**根本不会**在 com.bar 里被求值。

所以原实现同时犯了两个方向的错：
- **漏掉真风险**：同一个 App 的首页/设置页/播放器页也有「跳过」字样的按钮，点错才是真误触 ——
  而这才是需要拦的，原实现没有同 App 的负样本去卡
- **误杀好规则**：拿别的 App 的快照去卡一个 App 级规则，是把「不存在的问题」当成安全校验

**修复**：`selectNegatives()` 按作用域挑选 ——
App 级规则用**同 App 的非开屏快照**（真风险），全局组规则用**全部 App 的快照**；
跨 App 命中对 App 级规则降级为告警。

**同时新增**：`--subscription` 模式改为**结构自洽性校验**
（key 唯一性、引用完整性、选择器语法、组结构）。
原实现在这个模式下会拿快照去卡 7000+ 条社区规则 ——
它们绝大多数没有对应快照，必然大面积报「缺少目标快照」，等于没有校验能力。

---

### 缺陷 6 · 服务端图片字段检测误拒正常上报

**现象**：`/\b(image|screenshot|...)\b/i.test(JSON.stringify(body))` 对**整个请求体文本**做关键词扫描。

**根因**：扫描的是值，不是字段名。节点树里出现 `desc: "View image"`、
`id: "com.x:id/cover_image"` 之类正常内容就会被整条拒掉。

**修复**：改为**按字段名递归判定**（`findImageField()`），
命中时返回具体字段路径便于排查。

**验证**：`desc` 含 `"image"` 的正常树不再被误拒，且仍被正确识别为漏跳。

---

### 缺陷 7 · 服务端语义校验整体失效

**现象**：`/report` 存进队列的 `snapshot` 只有 `{ tree, appId }`，**没有 `expect`**。
校验器的语义检查（③ 不越界：确认点的是不是预期那个控件）在这种输入下整体失效 ——
`expectText` / `expectId` 都是 undefined，语义分支永远不会执行。

**为什么重要**：这正是「不能点到『确认支付』上去」这条安全底线的执行点。

**修复**：`detectLeak()` 已经定位到了「哪个节点是可点的跳过按钮」，
把它作为 `expect` 传下去（id 与文案），语义校验才真正生效。

**同时修复**（客户端与服务端同一处缺陷）：`detectLeak()` 只看节点**自身**的文案，
漏掉了最常见的真实结构 ——

```
FrameLayout
├ ImageView#skip_btn   ← 可点击，自身无文字
└ TextView  "跳过"      ← 文案在兄弟节点上
```

这类开屏广告占实际场景的大多数，原实现会把它们判成「不是漏跳」，
于是永远等不到规则被修复。客户端 `LeakNodeTreeSanitizer.countSkipButtons()` 同此缺陷，已一并修复。

---

### 缺陷 8 · 服务端缺少鉴权与限流

**现象**：`/report` 与 `/generate` 无任何鉴权，`access-control-allow-origin: *`。

**为什么重要**：`/generate` 会触发 LLM 调用 —— 任何人都能白嫖你的 API 额度。
服务默认监听 `0.0.0.0`（`server.listen(PORT)` 不指定 host 时监听所有网卡）。

**修复**：
- `AUTH_TOKEN` 环境变量 + `Authorization: Bearer` 校验（定长比较，避免时间侧信道）
- 每分钟请求数限流（`RATE_LIMIT_PER_MIN`），超限 429
- 默认监听地址改为 `127.0.0.1`；对外监听且未配置 token 时启动即告警
- 请求体体积与节点树深度/节点数上限（413）

---

### 缺陷 9 · `npm run gen:rules` 指向不存在的文件

**现象**：`package.json` 里挂着 `"gen:rules": "node ./scripts/rules-aggregator/generate-rules.mjs"`，
但该文件**不存在**，跑起来直接 `MODULE_NOT_FOUND`。

**修复**：补齐为 `scripts/rule-generator/generate-rules.mjs` ——
本地拿一份快照，一条命令产出经过校验的规则。支持 `--dry-run`（用模拟候选，不消耗额度），
完整复用服务端同一套校验逻辑。

---

### 缺陷 10 · 提示词在两处各有一份副本

**现象**：`scripts/llm/prompt.mjs` 与 `server/server.mjs` 各有一份 `SYSTEM_PROMPT`，
注释写着「保持同步」—— 靠人工同步迟早漂移。

**修复**：服务端改为 `import { SYSTEM_PROMPT, buildUserPrompt } from '../scripts/llm/prompt.mjs'`，
单一来源。

---

## 三、补全的缺失能力

### 3.1 快照语料库（安全闸门此前没有判别力）

**问题**：校验器的负样本检查是整条流水线的安全底线，但交接包里只有 **2 个手写快照**
（1 正 1 负，且分属不同 App）。语料不足的直接后果是
**任何 `[text*="跳过"]` 这样的宽松规则都能通过** ——
安全闸门退化成只查语法。

**方案**：`scripts/snapshot-corpus/generate-corpus.mjs` 用**界面模板**批量生成，
每个 App 产出 1 个开屏正样本 + 5 个非开屏负样本，负样本里刻意放置**语义诱饵**：

| 诱饵页面 | 诱饵文案 | 为什么危险 |
|---|---|---|
| 新手教程页 | 「跳过引导」 | 长得像跳过按钮，但点了会跳过教程 |
| App 内视频播放器 | 「跳过广告」 | 插播广告的开屏，与 App 内视频无关 |
| 设置页 | 「跳过不兼容项目」 | 完全无关的业务文案 |
| 表单流程页 | 「跳过此步」 | 流程性操作，点了会丢数据 |
| 首页信息流 | 「点击跳过广告可获得更多奖励」（不可点） | 测可点性判定 |

**验证**：语料库达到 **60 正 / 300 负**（满足 P4 验收标准「正样本 ≥ 50、负样本 ≥ 200」），
且**具备判别力**：

| 规则 | 判定 | 原因 |
|---|---|---|
| `[text*="跳过"]` | ❌ 拦截 | 在同 App 的 5 个非开屏界面上误命中 |
| `[clickable=true]` | ❌ 拦截 | 在同 App 的 4 个非开屏界面上误命中 |
| `[text="跳过"]` | ✅ 通过 | 精确匹配，且诱饵文案不同 |
| `[id="com.x:id/skip_btn"]` | ✅ 通过 | 精确匹配控件 id |

### 3.2 回归测试套件

交接包**没有任何测试**。新增 `scripts/tests/`，用 Node 22 内置 `node:test`，不引入额外依赖：

- `validator.test.mjs`（22 项）—— 编译与 `matches` 两种形态、负样本作用域语义、
  id 归属检查、语料库判别力、聚合产物的 `globalGroups`/组级字段/key 唯一性/引用完整性
- `server.test.mjs`（17 项）—— 漏跳识别、兄弟文案结构、图片字段真拒假拒、
  体积校验、脱敏、鉴权、限流

**共 39 项，全部通过。**

---

## 四、客户端实现（GKD fork）

### 4.1 交接文档中三处与上游源码不符的描述（已更正）

核对 `gkd-kit/gkd@main` 源码后发现：

| 交接文档的描述 | 上游实际情况 |
|---|---|
| 「现有代码已有一个 observed 调用点，请在其基础上累加」 | 上游**没有**在 `AndroidMatchHost` 里传 `observed` —— 该参数目前只有调试工具 `MatchDebugRuns.kt` 在用。所以这是**新增**参数 |
| `status == "action_finished"` 表示动作已执行 | 动作执行后 `status` 可能是 `result.outcomeReason`（`action_succeeded` / `action_failed` / `coordinate_calculation_failed`），只有坐标计算成功时才是 `action_finished`。**用字符串判断会把「点了但失败」误判成没触发 → 明明跳过了却上报漏跳** |
| 「queryAction 在第 750 行」「finally 在 833-838 行」 | 实际在 945 行与 1028 行（上游重构会变，文档已改为提示用 `grep` 定位） |

另外补上了交接文档漏掉的一条判定条件：**「本次查询确实覆盖到了规则」** ——
订阅未加载完或该 App 本就没有规则时，`currentRules` 为空，
此时任何界面都会被判成漏跳 → 每次启动 App 都白白上报一次。

### 4.2 实现内容（分支 `feature/auto-fix`）

| 文件 | 位置 | 职责 |
|---|---|---|
| `LeakDetector.kt` | commonMain | 汇总规则执行结果判定漏跳。纯逻辑，可单测 |
| `LeakNodeTreeSanitizer.kt` | commonMain | 基于平台中立的 `NodeInfo` 做端上脱敏；`countSkipButtons` 支持兄弟文案识别 |
| `LeakReporter.kt` | commonMain | 只上传脱敏节点树；指数退避重试 3 次；失败静默不影响主流程 |
| `LeakDetectionCoordinator.kt` | androidMain | 限频 60s + 独立 IO 协程 + 节点预算，绝不阻塞匹配主循环 |
| `SettingsStore.kt` | commonMain | `enableLeakReport` / `leakReportEndpoint` / `leakReportAuthToken`（默认关闭） |
| `AdvancedPage.kt` | commonMain | 开关 + 服务端地址/令牌编辑对话框 |
| `AndroidMatchHost.kt` | androidMain | 在 `queryRules` 的 `observed` 回调与 `finally` 中接入 |

**为什么脱敏器用 `NodeInfo` 而不是 `AccessibilityNodeInfo`**：
`NodeInfo` 是平台中立模型，用它做脱敏有两个好处 ——
脱敏能在 `jvmTest` 里直接写单测（脱敏是隐私红线，必须有测试兜底），
且直接复用上游 `captureNodeInfoList()` 的采集结果，不另写一套遍历。

### 4.3 验证

- `:gkd-app:compileKotlinJvm` ✅ BUILD SUCCESSFUL
- `:gkd-app:compileAndroidMain` ✅ BUILD SUCCESSFUL
- `:gkd-app:jvmTest` 新增 **17 项**单元测试全部通过
  - `LeakDetectorTest`（8 项）：规则已触发不误报、**动作失败也算已触发**、
    无可用规则不误报、无跳过按钮不误报、会话重置、跳过文案判定
  - `LeakNodeTreeSanitizerTest`（9 项）：手机号/余额被剥离、
    控件标识属性保留、树结构保留、**兄弟文案结构能识别**、
    不可点的「跳过」字样不算、空输入安全

---

## 五、尚未完成 / 需要用户决策的事

| # | 事项 | 原因 |
|---|---|---|
| 1 | **P0：装 GKD + 订阅社区源** | 需要真机操作，无法代劳。**这一步当天就能消除 80% 痛点**，先做它 |
| 2 | **P1：部署到自己的 GitHub 仓库** | `scripts/rules-aggregator/sources.mjs` 里的 `OUTPUT_UPDATE_URL` / `OUTPUT_CHECK_UPDATE_URL` 仍是占位符 `<your-account>`，需要填真实账号 |
| 3 | **P2：真机验证漏跳检测** | 需要真机 + 无障碍权限。代码已就绪并通过编译与单测，但**功耗数据（24h 耗电差异 < 3%）尚未实测** |
| 4 | **P3：LLM 生成的真实链路验证** | 需要 `LLM_API_KEY`。干跑模式（模拟候选）已验证「生成 → 校验 → 落库」链路通畅 |
| 5 | **P4：真实快照语料** | 当前语料是模板生成的合成快照。真实快照需从 GKD 的审查工具导出，覆盖真实 App 的真实结构 |
| 6 | 聚合器输出地址与订阅 id | `OUTPUT_SUBSCRIPTION_ID = 90210` 沿用了交接包的值，需确认不与社区源冲突 |

---

## 六、给下一个接手人的三点提醒

1. **负样本的作用域是这条流水线最容易搞错的地方。**
   GKD 的 App 级规则按包名严格作用域执行 ——
   拿别的 App 的快照去卡 App 级规则是把「不存在的问题」当成「安全校验」，
   会白白拒掉大量可用规则；而同 App 的非开屏页才是真正的误触风险。

2. **`matches` 有两种写法，踩错直接崩。**
   `"matches": "[text=\"跳过\"]"`（字符串）与
   `"matches": ["[text=\"a\"]", "[text=\"b\"]"]`（数组，命中任一即可）。
   把数组当字符串丢给编译器 → `a.a is not a function` 崩溃，**不是语法错误**。

3. **跳过的文案常常不在可点节点自己身上。**
   「可点的 ImageView + 旁边的 TextView『跳过』」是最常见的结构，
   客户端的漏跳判定、服务端的 `detectLeak`、校验器的语义检查
   三处都必须同时看兄弟节点的文案，否则会漏掉大半真实漏跳。
