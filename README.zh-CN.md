# dsh-codebuddy-auth

[English](README.md) | 简体中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH) 里直接使用[腾讯 CodeBuddy](https://www.codebuddy.cn)(IOA)的对话模型:浏览器 OAuth 登录、**多账户池**、**积分/额度查询**、**额度耗尽自动轮换**、token 自动续期、模型列表自动同步,并自带一个本机**设置/登录 Web UI**。登录一次,模型选择器里即可选用 `deepseek-v4-pro`、`glm-5.2`、`kimi-k3-1`、`minimax-m3` 等 craft agent 模型。

> 版本要求:适配 **DSH 0.1.7 rc2**(peer 依赖 `@deepseek-ai/cordis ~4.0.4`、`@deepseek-ai/dsh-llm ^0.1.7-rc.2`)与 **CodeBuddy CLI v2.158.0**。因使用了 0.1.7 的消息模型(`ToolCallId`、`role:'tool'` 一等消息),需将运行时升到 0.1.7 rc2 后再加载本插件。

## 工作原理

插件在 `codebuddy` provider 上注册**原生 `ctx.llm` 适配器**,自己持有整条请求链路:浏览器 OAuth、`ctx.credentials` 凭据存储、`/v3/config` 模型发现、自有的 SSE 流式与消息序列化。两套身份,按平面各司其职:

| 平面 | 身份 | 原因 |
| --- | --- | --- |
| 聊天(`POST /v2/chat/completions`) | CLI 客户端(`User-Agent: CLI/2.158.0 CodeBuddy/2.158.0` + `x-codebuddy-request: 1`) | 聊天端点期待 CLI 身份,用它可避开 IDE 身份拦截。 |
| 模型发现(`GET /v3/config`) | Craft / VSCode(`X-Agent-Intent: craft` + `X-IDE-*`) | craft 目录是唯一披露每模型推理元数据(`supportedEfforts`、`canDisableThinking`、`defaultEffort`)与精选模型列表的目录;CLI 目录同一端点只返回固定的 `effort` 值。 |

模型目录缓存 5 分钟,可随时 `sync-models` 刷新。

## 安装

DSH 通过官方 `dsh plugin` CLI 安装 profile 插件(它是个精简的 `pnpm` 转发器:安装依赖、把包追加到 profile 的 `dsh.profile.bundles` 层栈、再经包内的 patch 挂载插件——全程无需手动改文件)。

**前置条件**:确保 `pnpm` 在 `PATH` 里,例如用 Homebrew 安装:

```bash
brew install pnpm
```

### 安装插件

```bash
dsh plugin --profile web add github:cainiao1992/dsh-codebuddy-auth
```

这一条命令即从 GitHub 解析依赖、安装,并自动把插件作为 profile 层激活。

### 重启 DSH

重启 DSH,安装即完成——插件启动时在 `ctx.llm` 上原生注册 `codebuddy` provider,CodeBuddy 随即出现在模型页(未登录状态)。

## 登录

可以用 agent 登录,也可以用命令行登录,二选一。

### 方式一:通过 agent

对 agent 说 **"用 codebuddy 登录"**。agent 调用 `codebuddy` 工具:浏览器打开 IOA 登录页,后台轮询;token 到手后写入凭据并预热模型目录,下一个请求即以 CLI 身份直连聊天端点。

### 方式二:命令行(headless / 提前引导)

```bash
# 直接运行,无 npm 依赖,仅需 Node >= 18:
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# 或经 package.json 的 bin 字段从安装目录本地解析:
cd ~/.dsh/profiles/web && pnpm exec codebuddy-login

# 不想开浏览器(远程/服务器)加 --no-browser
```

CLI 只写凭据——原生适配器自己持有路由,没有 settings 路由需要管理;`--international` 仅选择登录走的 OAuth 端点。

## 卸载

```bash
dsh plugin --profile web remove dsh-codebuddy-auth
```

该命令会移除依赖,并把插件从 profile 层栈中摘除。重启 DSH 即完成卸载。

## 国际版

插件默认使用**国内版**(`copilot.tencent.com` / `www.codebuddy.cn`)。国际版(`www.codebuddy.ai`)通过挂载行的 `edition: intl` 配置选择:

```yaml
# 你的 cordis.patch.yml 挂载行:
- id: codebuddy-auth
  name: dsh-codebuddy-auth
  edition: intl          # 缺省即国内版
```

适配器与登录/模型发现随即全部使用 `www.codebuddy.ai` 端点。CLI 的 `--international` 仅为登录选择国际 OAuth 端点。

## 使用

- **切换模型**:模型选择器里选 CodeBuddy 下的任意模型(如 `deepseek-v4-pro`)
- **状态**:"看下 codebuddy 状态" → `codebuddy` 工具 `status`
- **续期(全自动,三层)**:① 每次启动时,token 剩余有效期不足 5 分钟(或已过期)即自动续;② 运行中每 30 分钟巡检,剩余不足 1 小时自动续——覆盖 dsh 长期不重启的场景;③ refresh token 失效(改密/吊销)时前两层会失败并留日志,此时说 "刷新 codebuddy" 确认,或重新登录
- **模型更新**:腾讯上新模型后,说 "同步 codebuddy 模型" → `sync-models`
- **退出**:"登出 codebuddy" → 清除凭据

### 推理

每个模型都按 `/v3/config` 报告的**完整真实推理能力**声明,模型选择器里展示该模型实际支持的等级:

- **可选等级**(按模型):`supportedEfforts` 原样进选择器——`deepseek-v4-pro` 可选 `low` / `high` / `xhigh`,`hy3` 可选 `low` / `high`,固定等级模型(如 `glm-5.1`)只有 `medium` 一档。线上以 `reasoning_effort: "<level>"` 发送。
- **默认等级**:每模型直接采用 `/v3/config` 报告的 `defaultEffort`(如 glm-5.2 默认 high),选择器里所有已声明等级仍可自由选。

## 多账户 / 积分 / 锁定切换

插件把所有登录过的账户存在凭据存储的单个 `CODEBUDDY_ACCOUNTS` 文档里(旧版单令牌安装会自动迁移为账户池的第 0 个账户),四种切换行为都支持:

- **配额耗尽自动轮换**:活跃账户命中额度/限流(QUOTA_EXCEEDED / RATE_LIMIT)时,自动把它置入冷却并切到下一个可用账户,同一条请求由下一个账户兜底。
- **手动锁定活跃账户**:`lock` 把某账户钉为活跃并禁用自动轮换(切走前需先解锁)。
- **多账户手动切换**:`activate <id>` 直接切换活跃账户。
- **被禁/不可用账户跳过**:`enabled:false`、冷却中、令牌缺失的账户在轮换与选择时被跳过。

积分/额度查询走 `POST /v2/billing/meter/get-user-resource`(实测):汇总未过期的 `credits` 资源包 `CapacityRemain` 得到剩余积分。三种入口:

- **内置设置 tab（推荐）**：安装后**重启 DSH**，打开**设置 → 内置插件**，即可看到 **CodeBuddy** tab——账户列表+状态+积分、页内登录新增、启用/禁用/删除、导入/导出、模型查看/同步。它是一个客户端插件，通过 `settings.plugins.tab` 插槽注册进内置设置面板（React，`lib/client.js`），同源调用仅 loopback 的 `/codebuddy/api/*` 路由。
- **agent**:说 "codebuddy 账户" / "查 codebuddy 积分" / "切换到 <id>" / "锁定这个账户"。
- **`codebuddy` 工具**:`accounts` / `activate` / `lock` / `quota` / `status` 等动作。

## 文件

- `lib/index.js` — Cordis 宿主插件(组合行)。注册 `codebuddy` provider 与 `codebuddy` 工具、持有账户池、驱动轮换与每 30 分钟续期/配额巡检。
- `lib/codebuddy-adapter.mjs` — 原生 `ctx.llm` 适配器(适配 DSH 0.1.7 rc2 消息模型):SSE 流式、消息序列化、推理元数据、错误映射、账户级失败回调。移植自 [shatyuka/dsh-llm-codebuddy](https://github.com/shatyuka/dsh-llm-codebuddy)(MIT)。
- `lib/codebuddy-core.mjs` — OAuth、JWT 解码、CLI/craft 身份头、`/v3/config` 发现、`/v2/plugin/account` 身份、`/v2/billing/meter/get-user-resource` 配额;无依赖。
- `lib/accounts.mjs` — 多账户池(读透式存储/增删改查/激活/锁定/禁用/冷却/轮换/导入导出/旧令牌迁移)。
- `lib/runtime.mjs` — 工具与 Web UI 共享的操作层(登录/刷新/配额/同步/账户控制),两个面不会漂移。
- `lib/web.mjs` — `dsh-codebuddy-auth/web` 独立插件，经 `ctx.webServer.register` 注册设置 tab 同源调用的 `/codebuddy/api/*` 路由（仅 loopback）。
- `lib/client.js` — 浏览器客户端插件（由 `dsh.client` 声明、web shell 自动加载）：一个 React 面板，通过 `settings.plugins.tab` 插槽注册进内置「设置 → 内置插件」的 **CodeBuddy** tab。手写 `React.createElement`（无 JSX/无构建），调 `/codebuddy/api/*`。
- `bin/login-flow.mjs` — 独立登录 CLI(单账户引导;写入的旧令牌会被账户池迁移收养),无 npm 依赖。
- `cordis.patch.yml` — 包内 patch(同时挂载主插件与 `/web` UI 行)。

## 已知限制(均为实测结论)

- `POST /v2/chat/completions` **不校验 User-Agent**,任意 UA 均可;但必须 `stream: true`(非流式返回 `code 11101`)。DSH 的 llm 适配器本来就是流式,无需处理。
- `GET /v3/config`(模型发现)需要 craft / VSCode 身份(`X-Agent-Intent: craft` + `X-IDE-*` 头)才会披露推理元数据;插件自己直接发请求完成。
- CodeBuddy 对每个 craft 模型都报告 `supportsReasoning`。模型按真实推理能力声明(按 `supportedEfforts` 列出等级),因此推理可在模型选择器里直接选用,而非被剥离。

## License

MIT
