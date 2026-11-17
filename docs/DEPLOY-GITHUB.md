# 长期部署指南（GitHub）

> 目标：把聚合订阅托管到 GitHub，GKD 客户端长期自动更新，不用本机开着。
> 全程约 10 分钟。

---

## 〇、先理解一件关键的事

GKD 的订阅更新流程是：

```
fetch checkUpdateUrl  →  比对 version  →  若 version 变大则 fetch updateUrl
```

而 **`updateUrl` 和 `checkUpdateUrl` 是写在订阅文件内部的**（不是客户端里配的）。

这意味着：**订阅文件里的地址必须和你对外暴露的地址一致**。
配错了的后果很隐蔽 ——

| 场景 | 表现 |
|---|---|
| 用户手动粘贴正确地址添加订阅 | ✅ 订阅能加、能显示规则、能跳广告，**一切看起来正常** |
| 客户端自动更新（跟随文件里的 updateUrl） | ❌ 永远失败 |

所以你不会立刻发现问题，要等社区源更新了、你的规则开始腐化，才发现订阅停在旧版本。
本仓库为此做了两道防护：

- `subscription.config.json` —— 地址只有一个地方改，不会漏改代码里的某处
- `npm run deploy:check` —— 推送后跑一次，验证「线上文件内部地址」与「对外地址」一致

---

## 一、准备仓库

在 GitHub 新建一个**公开**仓库（推荐名：`gkd-subscription`），不要初始化 README。

然后把本目录内容推上去：

```bash
cd gkd-pipeline

git init -b main          # 如果已经是 git 仓库就跳过
git add .
git commit -m "feat: 规则聚合流水线"
git remote add origin https://github.com/<你的账号>/gkd-subscription.git
git push -u origin main
```

> `dist/` 目录里已经有构建好的产物，一并推上去 —— 第一次推送后订阅立刻就能用，
> 不用等 CI 跑完。

---

## 二、填你的地址

编辑 `subscription.config.json`，只有 `baseUrl` 一处要改：

```json
{
  "baseUrl": "https://<你的账号>.github.io/gkd-subscription",
  "subscriptionId": 90210
}
```

### 两种托管方式，选一个

**A. GitHub Pages（推荐）**

```json
"baseUrl": "https://<你的账号>.github.io/<你的仓库>"
```

- 需要在仓库 `Settings → Pages → Build and deployment → Source` 选 **GitHub Actions**
- 国内访问比 raw.githubusercontent 稳，且**没有 CDN 缓存延迟**（版本检查即时生效）
- `dist/gkd.json5` 会被发布到站点根目录，所以地址后面**不加** `/dist`

**B. raw.githubusercontent（零配置）**

```json
"baseUrl": "https://raw.githubusercontent.com/<你的账号>/<你的仓库>/main/dist"
```

- 什么都不用配，现有 CI 提交回 `main` 就有
- 有约 5 分钟 CDN 缓存延迟；raw 在国内偶尔不稳

两种都部署的话，让 CI 同时产出两份（工作流已经这么做了），
baseUrl 填 Pages 的那个，raw 那份作为兜底。

> `subscriptionId` 保持 90210 就行 —— GKD 约定 id 不同的订阅更新会失败，
> 客户端里已添加的订阅 id 必须和文件里的一致。这个值**不要改**，
> 除非你打算让用户重新添加订阅。

改完提交：

```bash
git add subscription.config.json
git commit -m "chore: 配置部署地址"
git push
```

---

## 三、开启 Pages（如果选方案 A）

在 GitHub 仓库页面：

```
Settings → Pages → Build and deployment → Source: GitHub Actions
```

（如果 `actions/deploy-pages` 报 "Get Pages site failed"，说明还没开启，
去 Actions 页面手动跑一次 `规则聚合与构建` 工作流即可触发。）

---

## 四、验证部署

等 CI 跑完（首次约 3~5 分钟），然后在本地跑：

```bash
cd gkd-pipeline
npm run deploy:check
```

它会检查 5 件事：

```
[1] 地址配置        baseUrl 不是占位符
[2] 网络可访问性    gkd.json5 与 gkd.version.json5 都返回 200
[3] 内部地址自洽    线上文件里的 updateUrl 与对外地址一致  ← 最关键
[4] 版本一致性      线上版本号 == 本地版本号；订阅 id 一致
[5] 内容健康度      App 数 > 0；globalGroups > 0（防止聚合器丢字段的旧行为）
```

全绿就会打印「订阅地址可直接填进 GKD 客户端：<地址>」。

**如果第 [3] 项报错**，说明产物是用旧地址构建的：

```bash
npm run aggregate:strict   # 用当前配置重新构建
git add dist/ && git commit -m "chore: 重新生成产物" && git push
```

---

## 五、客户端订阅

GKD → 订阅 → 右下角 **+** → 粘贴：

```
https://<你的账号>.github.io/<你的仓库>/gkd.json5
```

添加成功后应该看到：

- 名称：`跳开屏广告 · 自动聚合订阅`
- 作者：`auto-aggregator`
- 统计：`Total global rule groups: 12，Apps: 1066，Total app rule groups: 3727`

---

## 六、CI 做了什么（以及需要你开权限）

`.github/workflows/aggregate.yml` 每 6 小时跑一次（`17 */6 * * *`）：

1. 探测 5 个社区源可用性（挂了就跳过，不整体失败）
2. 聚合社区源 + 本地自建规则 → `dist/gkd.json5`
3. 回归测试（39 项）
4. 校验自建规则（安全闸门）
5. 订阅结构自洽性校验 + 全量选择器语法检查
6. 上传 Pages 产物
7. 把 `dist/` 提交回 `main`（raw 兜底）

### 可能需要你处理的权限

**`git push` 失败（refusing to allow a GitHub App to create or update workflow）**

仓库 `Settings → Actions → General → Workflow permissions` 选
**Read and write permissions**。工作流已经声明了 `permissions: contents: write`，
但如果仓库策略是只读，还是会被拒。

**Pages 部署失败**

确认 `Settings → Pages → Source` 已选 **GitHub Actions**。

---

## 七、以后怎么更新

| 场景 | 做法 |
|---|---|
| 社区源更新了 | 不用管，CI 每 6 小时自动聚合 |
| 想立刻更新 | Actions 页面手动跑 `规则聚合与构建` |
| 改了 `subscription.config.json` | 提交后自动触发（工作流已监听该文件） |
| 加了自建规则 | 把文件放进 `rules/local/`，提交后自动触发 |
| 想强制版本号递增 | Actions → `规则聚合与构建` → Run workflow → 勾 `force` |

> 版本号只在**内容有变化**时才递增 —— CI 会 `git diff --staged` 判断，
> 没变化就跳过提交，客户端也就不会收到无意义的更新。

---

## 八、常见问题

**Q：订阅能加，但规则一直不更新？**
A：跑 `npm run deploy:check`。九成是第 [3] 项「内部地址自洽」不通过 ——
产物是用旧地址构建的。重新 `npm run aggregate:strict` 并提交 `dist/` 即可。

**Q：`global rule groups: 0`？**
A：产物是旧版本构建的。用当前代码重新构建。
（这正是我修复的那个聚合器缺陷 —— 早期版本把 `globalGroups` 整个丢了。）

**Q：CI 里 `npm ci` 失败？**
A：`package-lock.json` 与 `package.json` 不同步。删掉 lock 文件重新 `npm install` 再提交。

**Q：想同时托管到 Pages 和 raw？**
A：工作流已经同时做了（Pages 发布 + 提交回 main）。
`baseUrl` 填 Pages 地址，raw 那份作为客户端的备选。

**Q：自建服务端（漏跳自动修复）也要长期部署吗？**
A：那是另一回事，需要一台常开的机器（它要接手机的上报）。
可以部署到自己的服务器/ NAS，或用 Cloudflare Tunnel 之类的内网穿透。
详见 `docs/OPERATIONS.md`。
