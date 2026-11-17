# 跳开屏广告 · 自动修复流水线 · 交接包

> 一个自建版的「李跳跳 / GKD」，核心差异是**规则坏了能自己修**。
> 目标场景：个人手机自用 ｜ 技术路线：Kotlin + GKD 生态（fork GKD）

---

## 一句话说明

李跳跳已停更、GKD 官方订阅已归档、社区规则源各自腐烂 ——
所以真正该做的不是再写一个跳广告的 App，而是**建一条能自动产出规则的流水线**。

本交接包提供：**已跑通的规则聚合器**、**已验证的安全校验器**、**已实现的服务端**、
**精确到文件级的客户端改动清单**，以及全部踩坑记录。

---

## 快速开始

```bash
# 环境要求：Node >= 22（选择器引擎依赖 WebAssembly GC）
node -v

npm install

# 0. 跑一遍全部回归测试（39 项）
npm test

# 1. 校验器自检（好规则通过 / 坏规则被拦）
node scripts/rule-validator/validate.mjs --rules rules/local/com.demo.splash.json5; echo "退出码=$?"
node scripts/rule-validator/validate.mjs --rules fixtures/demo-rules/com.demo.bad.json5;  echo "退出码=$?"

# 2. 探测社区源可用性
node scripts/rules-aggregator/probe-sources.mjs

# 3. 聚合社区源（dry-run 不写文件）
node scripts/rules-aggregator/aggregate.mjs --dry-run

# 4. 正式聚合 + 结构校验 + 全量语法检查
node scripts/rules-aggregator/aggregate.mjs
node scripts/rule-validator/validate.mjs --subscription dist/gkd.json5
node scripts/rules-aggregator/check-syntax.mjs

# 5. 启动服务端
LLM_API_KEY=sk-xxx node server/server.mjs
curl http://127.0.0.1:8787/health

# 6. 用一份快照生成规则（干跑模式用模拟候选，不消耗额度）
node scripts/rule-generator/generate-rules.mjs \
  --snapshot fixtures/snapshots/pos-com.tencent.mm.json --dry-run
```

## 目录结构（v1.1）

```
gkd-pipeline/
├── docs/                     方案文档
├── scripts/
│   ├── rules-aggregator/     聚合器（保�� globalGroups / 全部组级字段；rule key 唯一）
│   ├── rule-validator/       安全闸门（按 GKD 作用域语义挑负样本）
│   ├── snapshot-corpus/      快照语料生成器（60 正 / 300 负，含同 App 诱饵）
│   ├── rule-generator/       规则生成 CLI（补全原交接包缺失的 gen:rules 入口）
│   ├── llm/prompt.mjs        LLM 提示词模板（服务端与 CLI 的单一来源）
│   └── tests/                回归测试（node:test，39 项）
├── server/server.mjs         漏跳上报 + LLM 生成服务（鉴权 / 限流 / 体积校验）
├── client-patches/           客户端改动清单（已按上游源码核对更正）
├── rules/local/              自建规则落库位置（LLM 产出）
├── fixtures/snapshots/       快照语料库
├── .github/workflows/        CI：定时聚合 + PR 把关
└── dist/                     聚合产物（gkd.json5 + gkd.version.json5）
```

配套的 GKD fork 在同级目录 `gkd-fork/`（分支 `feature/auto-fix`）。

---

## 文档导航

| 文档 | 什么时候看 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **先读这个**。总体架构、关键设计决策、已验证的技术结论、6 个必踩的坑 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 分阶段实施计划，每阶段有独立验收标准。**先做 P0 再做 P1** |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 部署规则仓库、服务端、CI，看监控指标与故障处理 |
| [client-patches/CLIENT-CHANGES.md](client-patches/CLIENT-CHANGES.md) | fork GKD 后要改哪些文件、哪些函数，含关键代码骨架与上游约定 |

---

## 目录结构

```
handoff/
├── docs/                     方案文档
├── scripts/
│   ├── rules-aggregator/     聚合器（已对真实社区源跑通，产出 1067 apps / 7835 规则）
│   ├── rule-validator/       安全闸门（已验证能拦截误触规则）
│   └── llm/prompt.mjs        LLM 提示词模板
├── server/server.mjs         漏跳上报 + LLM 生成服务（已跑通）
├── client-patches/           客户端改动清单
├── rules/local/              自建规则落库位置（LLM 产出）
├── fixtures/snapshots/       快照夹具（正样本 / 负样本）
├── .github/workflows/        CI：定时聚合 + PR 把关
└── dist/                     聚合产物（gkd.json5 + gkd.version.json5）
```

---

## 已验证的技术结论

| 结论 | 验证方式 | 结果 |
|---|---|---|
| 选择器引擎可脱离 Android 在纯 Node.js 中运行 | 用 `@gkd-kit/selector` npm 包构建节点树并匹配 | ✅ 通过 |
| 聚合器能拉到社区源并正确合并 | 对 4 个真实社区源跑聚合 | ✅ 1067 apps / 3724 组 / 7835 规则 |
| 合并后的产物选择器全部语法正确 | 用官方选择器引擎全量编译 7599 个选择器 | ✅ 0 错误 / 0 崩溃 |
| 校验器能拦截误触规则 | 用正/负样本夹具做正反测试 | ✅ 好规则通过(0) / 坏规则被拦(1) |
| 服务端能识别漏跳并拒绝带图上报 | HTTP 接口测试 | ✅ 通过 |
| 服务端脱敏能剥离敏感文案 | 用含手机号的样本测试 | ✅ 已剥离，保留控件标识 |

---

## 最重要的三件事

**1. 先做 P0，别急着写代码。**
装 GKD + 订阅一个活跃源，你的「手动更新规则」痛点当天就消失了。
本方案的其余部分解决的是「规则会腐烂」这个更长期的问题。

**2. `matches` 字段有两种写法，踩错会直接崩。**

```json5
"matches": "[text=\"跳过\"]"                        // 字符串
"matches": ["[text=\"鼓励一下\"]", "[text=\"下次再说\"]"]  // 数组
```
把数组当字符串丢给编译器 → `a.a is not a function` 崩溃，不是语法错误。
实测 7838 条社区规则里有 550 条是这个形态。详见 ARCHITECTURE.md §5.2。

**3. 误触比漏跳危险得多。**
点错「确认支付」的代价远大于多看 3 秒广告。所以校验器有**负样本检查**：
新规则必须在其它 App 的快照上**不命中**才能发布。这条不能为了「生成成功率」放宽。

---

## 许可与合规提醒

- **GKD 是 GPL-3.0**。个人自用无任何限制；若要对外分发，必须同样开源并保留协议声明。
- **GKD 官方《使用协议》另有一句「禁止用于商业用途」，与 GPL-3.0 的授权存在矛盾。**
  个人自用不受影响；若将来要商业化，这一条需要自行评估或咨询作者。
- **李跳跳被腾讯起诉过**是公开事实。国内对这类工具的容忍度有限，个人自用、不分发是稳妥选择。
- **无障碍权限可读取屏幕内容并模拟点击**，属于高敏感权限。部分金融/政务类 App 会检测并拒绝启动。
  个人自用时若出现这类问题，把该 App 加入「无障碍局部关闭」名单即可。
