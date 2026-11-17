# 跳开屏广告自动修复流水线 · 总体方案

> 版本：1.0 ｜ 定稿日期：2026-11-16
> 目标场景：**个人手机自用** ｜ 技术路线：**Kotlin + GKD 生态（fork GKD）**
> 目标层级：**L2 全自动流水线**

---

## 一、先厘清问题

「自己更新规则很麻烦」其实是**两件不同的事**，混在一起会导致选错方案：

| | 规则分发更新 | 规则内容产生与修复 |
|---|---|---|
| 含义 | 新规则怎么到手机上 | App 改版后规则失效，谁来修 |
| 现状 | **GKD 已解决**（`version` + `updateUrl` + `checkUpdateUrl`） | **所有同类工具的共同死穴** |
| 本项目 | 直接复用，无需开发 | **这才是要自建的部分** |

### 关键事实（已核实）

- **李跳跳已停更**：社区说法是因被腾讯起诉后停更，开发者宣布无限期停止更新，
  各大应用商店已全面下架。官网仍挂着规则包，但属人工维护的静态快照。
- **GKD 引擎健康**：GPL-3.0，4 万+ star，v1.13 仍在更新，2026-09 仍有密集重构。
- **GKD 内容侧崩了**：官方默认订阅 `gkd-kit/subscription` 已于 **2024-04 归档停更**。
  规则散落在几十个社区仓库，各自为政。
- **判断订阅源好坏只能看最后提交日期，星数毫无意义**：
  星最多的 AIsouler（1.19 万星）2026-02 后已停更；Lin-arm、ganlinte、梦念逍遥仍在更新。

---

## 二、总体架构

```
┌──────────────────────────── 你的手机 ────────────────────────────┐
│  GKD fork (Kotlin)                                              │
│    ├─ 引擎层：无障碍服务 / 选择器解析 / 快照系统 / 订阅更新  ← 复用 │
│    └─ 新增：漏跳检测 → 脱敏节点树 → 上报                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ POST /report（只传节点树，不传截图）
                                ▼
┌─────────────────────────── 自建服务端 ──────────────────────────┐
│  ① 漏跳判定：界面存在可点击的「跳过」类节点？                    │
│  ② LLM 生成：产出 2-4 个候选 GKD 选择器                         │
│  ③ 安全闸门：语法检查 + 目标快照命中 + 负样本不误触               │
│  ④ 通过 → 写入 rules/local/                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │ GitHub Actions
                                ▼
┌─────────────────────────── 规则仓库 ────────────────────────────┐
│  rules/local/          自建自动修复规则（最高优先级）             │
│  聚合任务：拉取社区源 → 按「包名+组名」取并集去重 → 校验 → 递增版本  │
│  产物：dist/gkd.json5 + dist/gkd.version.json5                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ GKD 客户端 checkUpdateUrl 自动比对
                                ▼
                          手机自动更新规则
```

---

## 三、分层拆解与边界

| 层 | 内容 | 自建 / 复用 |
|---|---|---|
| **引擎层** | 无障碍服务、选择器解析、快照系统、订阅版本比对 | **复用**（fork GKD） |
| **规则层** | 漏跳检测、LLM 生成、回归验证、自动合并 | **自建**（唯一核心价值） |
| **分发层** | 规则仓库、CI 构建、多 CDN 镜像 | **轻量自建**（一次搭好长期受用） |

---

## 四、关键设计决策

### 4.1 合并策略：以「包名 + 组名」为主键取并集

**不要**把多个社区源的 App 条目直接拼接。那样会出现同一 App 有 4 个「开屏广告」组，
GKD 端会重复触发，而官方文档明确指出「同时订好几份同源订阅最亏」。

正确做法：以 `appId + groupName` 为主键合并，组内规则取**并集去重**；
组级属性（`activityIds` / `matchTime` / `actionMaximum` 等）以权重最高的源为准。

实测效果：4 个源 → **1067 个 App / 3724 个组 / 7835 条规则**，无重复组。

### 4.2 冲突检测：只认「同选择器不同动作」

组名相同但选择器不同 → 不冲突，取并集即可。
真正的冲突只有一种：**同一个选择器指向不同动作**（例如 A 源说点关闭、B 源说点跳过）。
这种必须报出来，因为先执行哪个会改变页面状态，导致另一条永远不触发。

实现上区分两类：
- **跨源冲突**（A 源 vs B 源）：优先级最高，需人工确认
- **同源冲突**（A 源内部两个版本）：通常无害，已取并集

### 4.3 安全闸门：LLM 生成的规则绝不能直接发布

这是本方案与 GKD-Plus / GKD-XA 的**本质区别**：
那两个项目是「用户自己在看屏幕，AI 生成后写进本地规则」，风险由用户自己承担；
本项目要**自动发布到订阅**，必须服务端把关。

三重校验（任一不过就丢弃）：
1. **语法** — 选择器能编译
2. **命中** — 在目标快照上能选中预期节点（且 id/文案语义对得上）
3. **不误触** — 在其它 App 的快照上**不得**命中

第 3 条最关键：**误触的代价远大于漏跳**。点错「确认支付」比多看 3 秒广告严重得多。

### 4.4 隐私：只传节点树，绝不传截图

节点树里的文字理论上能反推用户在看什么。所以：
- 接口层**硬拒绝**任何含 `image/screenshot/base64/png` 字段的请求
- 脱敏时 `text` 只保留跳过类固定文案（"跳过"/"关闭广告"/"skip"…），其余一律剥离
- 上报数据只在内存队列保留 6 小时，不落盘
- 规则仓库与上报接口分离，用户数据不出本地

---

## 五、技术可行性（已实测验证）

### 5.1 离线回放验证可以在纯 Node.js 中完成 ✅

**这是整个 L2 方案成立的前提**，已端到端验证通过：

- GKD 的选择器引擎 `@gkd-kit/selector` 是官方发布的 npm 包（GPL-3.0，v0.6.1），
  内含完整的选择器解析与匹配引擎，**脱离 Android 也能跑**
- 适配器契约见 `JsNodeAdapter`：只需实现
  `getAttr` / `getName` / `getChildCount` / `getChild` / `getParent` / `getNodeKey` 六个方法
- 匹配入口：`adapter.querySelector(rootNode, selector, MatchOptions.default)`
- GKD 源码 `gkd-app/src/jvmMain/.../SimulatedNodeAdapter.kt` 里已有一份现成实现可直接参照

**实测结果**（7599 个真实社区选择器）：
```
规则条目 7835 | 选择器 7599 | 语法错误 0 (0.000%) | 崩溃 0
```

### 5.2 踩坑记录（务必先读，节省大量调试时间）

**坑 1：`matches` 字段有两种形态**

GKD 的 `RawRuleProps.matches` 类型是 `List<String>?`，实际存在两种写法：

```json5
// 形态 A：单个字符串
"matches": "[text=\"跳过\"]"

// 形态 B：字符串数组，表示「命中任意一个即可」
"matches": ["[text=\"鼓励一下\"]", "[text=\"下次再说\"]"]
```

**如果把形态 B 当成字符串直接丢给编译器，会直接抛异常崩溃**（`a.a is not a function`），
而不是返回语法错误。实测 7838 条规则里有 550 条踩了这个坑。必须先归一化成数组再逐个处理。

**坑 2：`Selector.compile()` 的返回值不是布尔**

Kotlin/JS 会混淆属性名。正确写法：

```js
import { Selector, SelectorCompileResult } from '@gkd-kit/selector';

const r = Selector.compile(source);
if (r instanceof SelectorCompileResult.Failure) {
  console.error(r.message);   // 注意是 .message，不是 .error.message
}
// 成功时用 r.value 取 Selector
```

读 `r.success` 会得到 `undefined`，读 `r.error.message` 也会炸。

**坑 3：`SelectorCompileResult` 是顶层导出，不在 `Selector` 命名空间下**

正确：`import { SelectorCompileResult } from '@gkd-kit/selector'`
错误：`Selector.SelectorCompileResult.Success` → `TypeError: Cannot read properties of undefined`

**坑 4：Node 版本必须 ≥ 22**

选择器内部的正则用 `regex-wasm`（Kotlin/Wasm），依赖 WebAssembly GC。
Node 22 以下会报 `a.a is not a function`（与坑 1 的现象相同，容易混淆）。

**坑 5：社区源会随时变更路径**

实测中 `ganlinte`、`Mrlc` 的 npmmirror 路径已 404，`114514` 返回 403。
所以聚合器**必须**支持多镜像 + 单源失败不阻塞整体（已实现）。

**坑 6：`jsDelivr` 缓存有最长 24h 延迟**

用于 `checkUpdateUrl` 可以接受；用于 `updateUrl` 会导致规则更新慢一天。

---

## 六、交付物清单

```
handoff/
├── README.md                        ← 本文件（总入口）
├── package.json                     ← 依赖：@gkd-kit/selector、json5
├── docs/
│   ├── ARCHITECTURE.md              ← 总体方案（你正在读的）
│   ├── OPERATIONS.md                ← 部署与运维手册
│   └── ROADMAP.md                   ← 分阶段实施计划与验收标准
├── scripts/
│   ├── rules-aggregator/
│   │   ├── sources.mjs              ← 社区源清单（可维护）
│   │   ├── aggregate.mjs            ← 聚合器（已对真实源跑通）
│   │   └── probe-sources.mjs        ← 源可用性探测
│   ├── rule-validator/
│   │   └── validate.mjs             ← 安全闸门（已验证可拦截坏规则）
│   └── llm/prompt.mjs               ← LLM 提示词模板
├── server/
│   └── server.mjs                   ← 上报 + 生成服务（已跑通）
├── client-patches/
│   └── CLIENT-CHANGES.md            ← 客户端改动清单（精确到文件/函数）
├── rules/local/                     ← 自建规则（LLM 产出落在这里）
├── fixtures/snapshots/              ← 快照夹具（正/负样本）
└── .github/workflows/
    ├── aggregate.yml                ← 定时聚合 + 构建
    └── validate.yml                 ← 合并前安全校验
```

---

## 七、现状自检表

接手开发机后，按此顺序验证环境：

```bash
node -v                    # 必须 >= 22
npm install                # 装 @gkd-kit/selector 与 json5

# 1. 选择器引擎能跑
node -e "import('@gkd-kit/selector').then(m=>console.log(Object.keys(m).length+' exports'))"

# 2. 校验器能正确拦截坏规则（期望：好规则通过退出码 0，坏规则被拦退出码 1）
node scripts/rule-validator/validate.mjs --rules rules/local/com.demo.splash.json5; echo $?
node scripts/rule-validator/validate.mjs --rules fixtures/demo-rules/com.demo.bad.json5; echo $?

# 3. 聚合器能拉到社区源（期望：≥3 个源成功）
node scripts/rules-aggregator/aggregate.mjs --dry-run

# 4. 服务端能起
node server/server.mjs   # 另开终端 curl http://127.0.0.1:8787/health
```

---

## 八、阶段计划

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P0** | 装 GKD + 订阅社区活跃源 | 立即可用，消除手动更新烦恼 | 0.5 天 |
| **P1** | 自建规则仓库 + CI 聚合 | 供给侧自主可控，永不断供 | 1-2 天 |
| **P2** | fork GKD + 漏跳检测 + 上报 | 传感器就位 | 3-5 天 |
| **P3** | 服务端 LLM 生成 + 校验器串联 | 规则坏了能自动修 | 3-5 天 |
| **P4** | 快照库积累 + 灰度发布 | 验证集覆盖主流 App | 持续 |

**先做 P0 再做 P1**：P0 让你今天就不必再手动更新规则，P1 才是长期保障。
P2/P3 属于"锦上添花"——P1 之后规则供给已经不会断，只是修复仍需人工。
