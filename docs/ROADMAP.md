# 分阶段实施计划与验收标准

> 目标场景：个人手机自用 ｜ 技术路线：Kotlin + GKD 生态（fork GKD）
> 每个阶段都有**可独立验收**的产出，不要跳阶段。

---

## P0 · 装好 GKD，消除手动更新（0.5 天）

### 做什么
1. 从 `gkd.li` 或 GitHub Releases 下载 GKD 官方版安装
2. 开启无障碍权限
   - 从浏览器/网盘装 APK 时，小米/OPPO/vivo 常不给开 → 去「应用信息 → 允许受限制的设置」打开
3. 在「订阅」里添加一个**仍在维护**的社区源（不要用已归档的 `gkd-kit/subscription`）

### 推荐源（2026-11 实测可用）

| 源 | 地址 | 备注 |
|---|---|---|
| Lin-arm | `https://cdn.jsdelivr.net/gh/Lin-arm/GKD_subscription@main/dist/gkd.json5` | 1004 apps，覆盖最广 |
| AIsouler | `https://registry.npmmirror.com/@aisouler/gkd_subscription/latest/files/dist/AIsouler_gkd.json5` | 886 apps，星最多但更新放缓 |
| Adpro | `https://registry.npmmirror.com/@adpro/gkd_subscription/latest/files/dist/Adpro_gkd.json5` | 678 apps |
| 梦念逍遥 | `https://registry.npmmirror.com/gkd-subscription/latest/files/dist/gkd.json5` | 285 apps |

> **只订 1 个主力源**。官方文档明确指出「同时订好几份同源订阅最亏」——
> 同一批规则来回跑会重复触发、拖慢匹配、增加功耗。

### 验收标准
- [ ] 打开微信/淘宝/抖音等 App，开屏广告在 1 秒内被自动跳过
- [ ] 连续使用 3 天，**不需要手动点任何「更新订阅」**
- [ ] 确认 GKD 未被系统杀（最近任务里能看到，或已锁定）

### 交付后可以做什么
日常不再需要管规则更新。**这一步已经解决了你 80% 的痛点。**

---

## P1 · 自建规则仓库与 CI 聚合（1-2 天）

### 做什么
1. 建 GitHub 仓库，按 `docs/OPERATIONS.md` §2 部署
2. 修改 `scripts/rules-aggregator/sources.mjs` 的输出地址与订阅 id
3. 配置 GitHub Actions 权限（Read and write）
4. 手动跑一次聚合，确认产物正常
5. 客户端把订阅换成自己的地址

### 验收标准
- [ ] `node scripts/rules-aggregator/probe-sources.mjs` 输出 ≥ 3 个源可用
- [ ] `node scripts/rules-aggregator/aggregate.mjs` 成功产出 `dist/gkd.json5`
- [ ] 产物规模 ≥ 900 apps（当前实测 1067）
- [ ] `node scripts/rules-aggregator/check-syntax.mjs` 语法错误率 < 0.5%
- [ ] 客户端换成自己的订阅后，跳广告效果**不劣于**订阅社区源
- [ ] 手动改一次 `rules/local/` 里的规则，CI 在 6 小时内自动构建并推送新版本
- [ ] 客户端自动拉到新版本（不需要手动刷新）

### 关键点
这一步之后，**规则供给不再依赖任何人的 GitHub 仓库**。
社区源全部停更，你自己的订阅照样工作。

---

## P2 · 客户端漏跳检测（3-5 天）

### 做什么
按 `client-patches/CLIENT-CHANGES.md`：

1. fork GKD，建 feature 分支
2. 实现 `LeakDetector`（commonMain）
3. 实现 `NodeTreeSanitizer`（commonMain）
4. 实现 `LeakReporter`（commonMain）
5. 在 `AndroidMatchHost.queryAction()` 挂上 `observed` 回调与漏跳评估
6. 加设置项（默认关闭）
7. 写单元测试（用 `jvmTest` + `SimulatedNodeAdapter`）

### 验收标准
- [ ] 单元测试覆盖：规则已触发时不误报 / 有跳过按钮且无规则触发时正确上报
- [ ] 真机验证：装一个没有规则的 App（如某个冷门 App），能检测到漏跳并成功上报
- [ ] 真机验证：有规则的 App 正常跳过时**不产生**上报
- [ ] **功耗测试**：开启漏跳检测前后对比 24 小时耗电，差异 < 3%
- [ ] 上报内容检查：抓包确认**不含任何图片**，且非跳过类文案已被剥离

### 关键点
这是整条流水线的「传感器」。它必须**足够准**（不误报）且**足够轻**（不影响功耗），
否则后面所有环节都白搭。

---

## P3 · 服务端 LLM 生成与自动修复（3-5 天）

### 做什么
1. 部署 `server/server.mjs`（本交接包已实现并跑通）
2. 配置 LLM API
3. 端上 `/report` → 服务端 `/generate` 打通
4. 生成结果写入 `rules/local/`，由 P1 的 CI 收进产物
5. 快照库扩充：从 GKD 的快照审查工具导出正/负样本

### 验收标准
- [ ] 服务端能正确识别漏跳（`/report` 返回 `accepted: true`）
- [ ] LLM 生成的候选规则**全部**经过校验器验证
- [ ] 故意构造一条会误触的规则，校验器**必须拦截**（用 `fixtures/demo-rules/com.demo.bad.json5` 验证）
- [ ] 真实场景端到端跑通：删掉某 App 的现有规则 → 打开该 App → 自动生成新规则 → 恢复跳过功能
- [ ] 生成 10 条规则做人工复核，**误触 0 条**

### 关键点
**宁可漏跳也不能误触。** 校验器的负样本检查是这条流水线的安全底线，
绝对不能为了「生成成功率」而放宽。

---

## P4 · 快照库与灰度（持续）

### 做什么
1. 持续从真实使用中积累快照（正样本 = 开屏广告页，负样本 = 同 App 的其它页面）
2. 快照库达到一定规模后，校验器的判别力显著提升
3. 新规则先灰度到少量用户，观察误触率再全量

### 验收标准
- [ ] 正样本覆盖 ≥ 50 个主流 App 的开屏页
- [ ] 负样本覆盖 ≥ 200 个界面（每个 App 至少 3 个非开屏页）
- [ ] 自动修复的成功率 ≥ 60%（漏跳上报中能被自动修复的比例）
- [ ] 自动生成规则的误触率 = 0

---

## 风险与对策速查

| 风险 | 影响 | 对策 |
|---|---|---|
| 社区源全部停更 | 规则供给断供 | P1 完成后不存在此风险 |
| LLM 生成错误规则 | 误触用户界面 | 校验器 + 负样本 + 人工复核（P3/P4） |
| 漏跳检测误报 | LLM 成本浪费 | 限频 + 三重判定条件 |
| 漏跳检测增加功耗 | 用户体验下降 | 独立 IO 协程 + 每 App 60s 一次上限 |
| 上报泄露隐私 | 合规问题 | 只传节点树 + 脱敏 + 拒绝图片字段 + 不落盘 |
| 无障碍被系统杀 | 工具失效 | Shizuku/ADB + 前台服务 + 锁定引导 |
| App 检测无障碍 | 无法启动 | 应用级白名单（上游已有该机制） |
| GPL-3.0 传染性 | 分发受限 | 个人自用无影响；若要分发必须开源并保留协议声明 |
