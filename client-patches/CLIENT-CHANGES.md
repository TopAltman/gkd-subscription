# 客户端改动清单（GKD fork）

> 目标：在 fork 的 GKD 上实现「漏跳检测 + 快照脱敏上报 + 订阅源切换到自有仓库」。
> 客户端侧工作量约 3-5 天。本文给出精确到文件与函数级的改动点，以及关键代码骨架。

## 0. 前置：fork 与分支

```bash
# 国内网络建议走镜像
git clone --depth 1 https://gitclone.com/github.com/gkd-kit/gkd.git
cd gkd
git remote add upstream https://github.com/gkd-kit/gkd.git
git checkout -b feature/auto-fix
```

**必须遵守的项目约定**（摘自上游 `AGENTS.md`，违反会被上游风格检查拒绝）：

- 模块依赖方向：`gkd-android` → `gkd-app` → `gkd-db` / `gkd-selector`，**禁止反向依赖**
- 公共根包与 Android namespace 均为 `li.gkd.app`，源码目录必须与包名一致
- `commonMain` 放业务/UI/ViewModel，`androidMain` / `jvmMain` 放平台实现
- 平台差异用 `expect/actual`，实现文件后缀 `.android.kt` / `.jvm.kt`；**禁止整份 ViewModel/Repository actual 化**
- 不支持的平台动作统一返回 `PlatformResult<T>`，不得用 Boolean/null 暗示不支持
- 禁止新增 XML（Compose strings 除外）；文案统一用官方 Compose Resources
- 参数只用 `%1$s` 位置占位符，禁止数值/精度格式指令
- 按明确需求做最小改动，不得为假设中的异常新增状态/缓存/抽象层

---

## 1. 改动总览

| # | 改动 | 涉及文件 | 类型 |
|---|---|---|---|
| A | 漏跳检测（核心传感器） | `matching/query/RuleQuery.kt` | 修改 |
| B | 漏跳上报客户端 | 新增 `network/LeakReporter.kt` | 新增 |
| C | 快照脱敏序列化 | 新增 `snapshot/NodeTreeSanitizer.kt` | 新增 |
| D | 上报开关设置项 | `settings/SettingsRepository.kt` + UI | 修改/新增 |
| E | 订阅源指向自有仓库 | 无需改代码，改配置 | 配置 |

---

## 2. A. 漏跳检测

### 2.1 为什么挂在 `queryRules` 的 `observed` 回调上

`queryRules` 是**生产与模拟共用的规则遍历入口**（`gkd-app/src/commonMain/kotlin/li/gkd/app/matching/query/RuleQuery.kt`），
它已经为每条规则提供了完整的生命周期回调：

```kotlin
suspend fun <N : Any> queryRules(
    work: MatchWork,
    activity: ForegroundRuleSnapshot,
    nodes: RuleQueryNodes<N>,
    source: N?,
    forced: Boolean,
    isCurrent: () -> Boolean,
    schedule: (ResolvedRule, RuleDelayKind, Long) -> Unit,
    correctApp: (String) -> Unit,
    completed: (ResolvedRule, N, ActionResult) -> Unit,
    execute: Boolean = true,
    observed: ((ResolvedRule, String, Boolean, ActionResult?) -> Unit)? = null,   // ← 关键
)
```

`observed` 的语义（**已按上游当前源码核对，行号以 gkd-kit/gkd@main 为准**）：
- `status` 取值来自上游 `RuleQuery.kt`：
  `Ready`（规则状态非 Ready 时）/ `node_unavailable` / `foreground_conflict` /
  `not_matched` / `matched_without_execution` /
  `action_finished`（动作成功）/ `action_failed`、`action_succeeded`、
  `coordinate_calculation_failed`（`ActionResult.outcomeReason`）
- `matched` 布尔值表示是否命中
- **它在每条规则每次尝试后都会回调，包括未命中的情况**

这是理想的埋点位置：不需要改匹配引擎逻辑，只需要在 `AndroidMatchHost` 传入 `observed` 时
增加一个「漏跳汇总器」的钩子。

> ⚠️ **两处与本文早期描述不符，已按上游源码更正**：
>
> 1. **上游目前并没有在 `AndroidMatchHost` 里传 `observed`** ——
>    `queryRules` 的这个参数目前只有 `development/matching/MatchDebugRuns.kt`（调试工具）在用。
>    所以客户端改动是**新增**一个参数，不是「在现有调用点基础上累加」。
> 2. **不要用 `status == "action_finished"` 判断「动作已执行」**。
>    上游在动作执行后回调时，`status` 可能是 `result.outcomeReason`
>    （`action_succeeded` / `action_failed` / `coordinate_calculation_failed`），
>    只有坐标计算成功时才是 `action_finished`。
>    动作执行失败时用 status 字符串判断，会把「点了但失败」误判成「没触发」→ 明明跳过了却上报漏跳，
>    白白消耗 LLM 额度。**正确判据是 `result != null`。**

### 2.2 实现思路

新增一个 commonMain 的检测器，职责是：

1. 记录本次查询会话中，**所有规则都没有命中**的事实
2. 当会话结束时（即 `observed` 里出现 `action_finished` 或查询上下文切换），
   再检查当前界面上是否存在「跳过类文案的可点击节点」
3. 若存在 → 判定为漏跳，抓取节点树并上报

**关键点：不能只看「没有规则命中」就上报。** 因为：
- 用户可能本来就不想跳过（比如已经手动点过了）
- 同一界面可能有多个规则组，部分命中部分未命中，属于正常
- 没有跳过按钮的界面误报，会把 LLM 成本浪费在无效请求上

正确判定条件（**四者同时成立**）：
- 当前 App 在监控白名单内
- 本次查询周期内**没有任何规则**触发过 action
- **本次查询确实覆盖到了规则**（订阅未加载完 / 该 App 本就无规则时不能判定为漏跳）
- 当前根节点树中存在可点击的、文本匹配跳过类文案的节点

> ⚠️ **兄弟文案陷阱**：最常见的开屏广告结构是「可点的 ImageView（自身无文字）
> + 旁边的 TextView『跳过』」。判定跳过按钮时**必须同时看兄弟节点的文案**，
> 只看节点自身会漏掉绝大多数真实漏跳。
> 本仓库的实现见 `gkd-fork/.../LeakNodeTreeSanitizer.kt` 的 `countSkipButtons`。

### 2.3 关键代码骨架

新增文件 `gkd-app/src/commonMain/kotlin/li/gkd/app/matching/diagnostics/LeakDetector.kt`：

```kotlin
package li.gkd.app.matching.diagnostics

import li.gkd.app.rule.ResolvedRule
import li.gkd.app.model.ActionResult

/**
 * 汇总一次查询周期内各规则的结果，判定是否发生「漏跳」。
 *
 * 只负责判定，不负责上报 —— 上报由 LeakReporter 负责，两者解耦。
 */
class LeakDetector(
    private val skipTexts: List<String> = DEFAULT_SKIP_TEXTS,
) {
    private var anyActionTriggered = false
    private var appId: String? = null

    fun beginSession(appId: String?) {
        this.appId = appId
        this.anyActionTriggered = false
    }

    /** 由 queryRules 的 observed 回调驱动。 */
    fun onRuleObserved(
        status: String,
        matched: Boolean,
        result: ActionResult?,
    ) {
        // 判据是 result != null，而不是 status 字符串 —— 见 §2.1 的说明
        if (result != null) anyActionTriggered = true
    }

    /** 本轮查询结束时判断：是否存在被跳过的跳过按钮。 */
    fun evaluateLeak(hasSkipButton: Boolean): Boolean =
        !anyActionTriggered && hasSkipButton

    companion object {
        val DEFAULT_SKIP_TEXTS = listOf(
            "跳过", "跳过广告", "跳过此广告", "关闭广告", "不再显示",
            "skip", "skip ad", "close ad",
        )
    }
}
```

在 `AndroidMatchHost.queryAction()`（`gkd-app/src/androidMain/kotlin/li/gkd/app/matching/AndroidMatchHost.kt`）
中，把 `observed` 回调补上：

> 行号提示：`queryAction()` 的定义位置随上游重构会变，
> 用 `grep -n "private suspend fun queryAction" AndroidMatchHost.kt` 定位，不要照抄行号。

```kotlin
// 现有代码已有一个 observed 调用点，请在其基础上累加漏跳统计
observed = { rule, status, matched, result ->
    leakDetector.onRuleObserved(rule, status, matched, result)
},
```

并在 `queryAction` 的 `finally` 块里追加漏跳评估（`finally` 块在函数末尾，
同样用 `grep -n` 定位，不要照抄行号）：

```kotlin
finally {
    a11yContext.queryJob = null
    // ... 原有清理逻辑
    // 漏跳评估：仅在无任何规则触发时进行，且要求根节点可读
    if (leakDetectionEnabled && !leakDetector.anyActionTriggered) {
        scope.launch(Dispatchers.IO) {
            val root = queryRootNode() ?: return@launch
            val tree = captureSanitizedTree(root)          // 见 §3
            val hasSkip = tree.hasClickableSkipButton(leakDetector.skipTexts)
            if (leakDetector.evaluateLeak(hasSkip)) {
                LeakReporter.report(appId, activityId, tree)
            }
        }
    }
}
```

> ⚠️ **性能红线**：以上评估必须在**独立协程 + Dispatchers.IO** 中执行，绝不能阻塞匹配主循环。
> GKD 的匹配是有界队列 + 串行 worker 设计，任何阻塞都会导致漏跳检测反过来拖慢匹配、
> 增加功耗。评估频率建议限制为「同一 App 每 60 秒最多一次」。

---

## 3. C. 快照脱敏序列化

新增文件 `gkd-app/src/commonMain/kotlin/li/gkd/app/snapshot/NodeTreeSanitizer.kt`：

```kotlin
package li.gkd.app.snapshot

/**
 * 把 AccessibilityNodeInfo 树转换为可上报的脱敏结构。
 *
 * 隐私约束（与本项目服务端 server/server.mjs 的 sanitizeTree 保持一致）：
 *  - 不含任何图片/截图
 *  - text 仅保留跳过类固定文案，其余剥离
 *  - 保留 id / className / clickable / visibleToUser 等控件标识
 */
object NodeTreeSanitizer {
    fun sanitize(root: AccessibilityNodeInfo?, skipTexts: List<String>): SanitizedNode? { ... }
}

data class SanitizedNode(
    val name: String,
    val attributes: Map<String, String>,
    val children: List<SanitizedNode>,
)
```

**务必复用上游已有的采集逻辑**：`gkd-app/src/androidMain/kotlin/li/gkd/app/data/NodeInfoCapture.kt`
里的 `captureNodeInfoList(root)` 已经处理好了 idQf/textQf 判定（当某节点同时具备 id 与 text 时，
会认为两者等价，这是上游的优化，采集后可以显著减小快照体积）。
建议在它的基础上做脱敏，而不是另写一套遍历。

---

## 4. B. 漏跳上报客户端

新增文件 `gkd-app/src/commonMain/kotlin/li/gkd/app/network/LeakReporter.kt`：

```kotlin
package li.gkd.app.network

/**
 * 漏跳快照上报。
 *
 * 约束：
 *  - 只 POST 节点树 JSON，绝不上传截图
 *  - 失败静默重试（指数退避，最多 3 次），失败不影响主流程
 *  - 上报前检查网络状态与开关设置
 */
object LeakReporter {
    suspend fun report(
        appId: String,
        activityId: String?,
        tree: SanitizedNode,
    ): Boolean { ... }
}
```

网络层可复用 `gkd-app/src/commonMain/kotlin/li/gkd/app/network/NetworkClients.kt`
中已有的客户端封装，不要另起炉灶。

---

## 5. D. 设置项

在 `gkd-app/src/commonMain/kotlin/li/gkd/app/settings/SettingsRepository.kt`
中新增：

```kotlin
val enableLeakReport: Boolean = false   // 默认关闭，需用户显式开启
val leakReportEndpoint: String = ""      // 自建服务端地址
val leakReportAppWhitelist: Set<String> = emptySet()  // 只上报这些 App
```

UI 位置建议：设置页 → 高级设置 → 「漏跳自动上报」。

文案必须走官方 Compose Resources（`Res.string.xxx`），不要建自定义文案表。
参考上游写法：`import li.gkd.app.resources.*`，然后用 `Res.string.your_key`。

---

## 6. E. 订阅源切换

**不需要改代码。** GKD 客户端侧已在 `SubscriptionRepository`（`gkd-app/src/commonMain/kotlin/li/gkd/app/subscription/SubscriptionRepository.kt`）
实现了完整的订阅更新逻辑：

- `refresh(id)` 定时/手动拉取
- `fetchUpdate(entry)` 先请求 `checkUpdateUrl`（轻量，只含 id+version），
  若 id 相同且 version 递增，再去请求 `updateUrl` 拉全量
- 只有 `version` 严格大于本地版本才替换

所以你只要在 GKD 客户端「订阅 → +」里填入自己聚合产物的地址即可：

```
https://raw.githubusercontent.com/<你的账号>/<你的仓库>/main/dist/gkd.json5
```

建议同时用 jsDelivr 镜像作为备用（`checkUpdateUrl` 与 `updateUrl` 都填 jsDelivr，
因为它在国内比 raw 稳定；jsDelivr 有最长 24h 的缓存延迟，对规则更新来说可接受）。

---

## 7. 客户端侧测试要点

上游已有完整的测试基建：

- `gkd-app/src/androidHostTest/` — 需设备的测试（用 `gkd-a11y-fixture` 模块）
- `gkd-app/src/jvmTest/` — 纯 JVM 测试，可直接跑
- `gkd-app/src/jvmMain/.../development/matching/SimulatedNodeAdapter.kt` —
  **现成的离线节点适配器**，可直接复用来测漏跳检测

漏跳检测的单元测试建议写在 `jvmTest` 下，用 `SimulatedNodeAdapter` + `MatchSimulatedNode`
构造场景，避免依赖真机：

```kotlin
// 伪代码
@Test
fun `漏跳时应被检测到`() {
    val tree = simulatedTreeWithSkipButton()
    val detector = LeakDetector()
    detector.beginSession("com.demo")
    detector.onRuleObserved(rule, "not_matched", false, null)
    assertTrue(detector.evaluateLeak(hasSkipButton = true))
}

@Test
fun `规则已触发时不应误报`() {
    val detector = LeakDetector()
    detector.beginSession("com.demo")
    detector.onRuleObserved(rule, "action_finished", true, result)
    assertFalse(detector.evaluateLeak(hasSkipButton = true))
}
```

---

## 8. 风险清单（客户端侧）

| 风险 | 说明 | 应对 |
|---|---|---|
| **无障碍服务被系统杀** | MIUI/HyperOS/MagicOS 后台限制严格 | Shizuku/ADB 授权 + 前台服务 + 「最近任务」锁定引导 |
| **部分 App 检测无障碍** | 淘宝、抖音、微信及银行类 App 会检测并拒绝启动 | 应用级白名单，在这些 App 内关闭无障碍（上游已有 `enableBlockA11yAppList` 机制） |
| **从非应用商店安装无法开启无障碍** | 小米/OPPO/vivo 常见 | 引导用户去应用信息 → 「允许受限的设置」 |
| **功耗上升** | 漏跳检测增加节点遍历 | 严格限频（每 App 60s 一次）+ 独立 IO 协程 + 只在无规则触发时评估 |
| **误触** | 生成的选择器点错按钮 | 服务端校验器把关；客户端可再加一层「同一 App 最多自动跳过 N 次」的上限 |

> **金融类 App 特别注意**：本项目面向个人自用，但若未来在公司设备上使用，
> 必须把银行、支付、保险类 App 加入无障碍禁用白名单。无障碍权限可以读取屏幕内容并模拟点击，
> 误触「确认支付」的代价远大于多看 3 秒广告。
