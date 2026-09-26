# dsh-codebuddy-auth

English | [简体中文](README.zh-CN.md)

Use [Tencent CodeBuddy](https://www.codebuddy.cn) (IOA) chat models directly in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): browser OAuth login, a **multi-account pool**, **credit/quota lookup**, **auto-rotation on exhaustion**, automatic token renewal, model-list sync, and a built-in loopback **settings/login web UI**. Log in once, and craft-agent models such as `deepseek-v4-pro`, `glm-5.2`, `kimi-k3-1`, and `minimax-m3` appear in the model picker.

> Version target: built for **DSH 0.1.7 rc2** (peer deps `@deepseek-ai/cordis ~4.0.4`, `@deepseek-ai/dsh-llm ^0.1.7-rc.2`) and **CodeBuddy CLI v2.158.0**. It uses the 0.1.7 message model (`ToolCallId`, first-class `role:'tool'` messages), so upgrade the runtime to 0.1.7 rc2 before loading this plugin.

## How it works

The plugin registers a **native `ctx.llm` adapter** on the `codebuddy` provider and owns the whole request path: browser OAuth, token storage in `ctx.credentials`, model discovery from `/v3/config`, and its own SSE streaming + message serialization. Two deliberate identities, one per plane:

| Plane | Identity | Why |
| --- | --- | --- |
| Chat (`POST /v2/chat/completions`) | CLI client (`User-Agent: CLI/2.158.0 CodeBuddy/2.158.0` + `x-codebuddy-request: 1`) | The CLI identity is what the chat endpoint expects; using it avoids IDE-identity blocks. |
| Model discovery (`GET /v3/config`) | Craft / VSCode (`X-Agent-Intent: craft`, `X-IDE-*`) | The craft catalog is the only one disclosing per-model reasoning metadata (`supportedEfforts`, `canDisableThinking`, `defaultEffort`) and the curated model list. The CLI catalog answers the same endpoint but carries only fixed `effort` values. |

The catalog is cached for 5 minutes and refreshed on demand (`sync-models`).

## Installation

DSH installs profile plugins through its official `dsh plugin` CLI (a thin `pnpm` forwarder: installs the dependency, appends the package to the profile's `dsh.profile.bundles` layer stack, and mounts the plugin via the bundle's in-package patch — no manual file editing).

**Prerequisite**: make sure `pnpm` is on your `PATH`, e.g. via Homebrew:

```bash
brew install pnpm
```

### Install the plugin

```bash
dsh plugin --profile web add github:cainiao1992/dsh-codebuddy-auth
```

This single command resolves the dependency from GitHub, installs it, and activates the plugin as a profile layer.

### Restart DSH

Restart DSH. The plugin registers the `codebuddy` provider natively on `ctx.llm` at startup, so CodeBuddy already appears in the Models page — unauthenticated — before you log in.

## Log in

You can log in either through the agent, or from the command line. Pick one.

### Option A — through the agent

Tell the agent **"log in with codebuddy"**. The agent calls the `codebuddy` tool, which opens the IOA login page in your browser and polls in the background; once the token arrives it writes credentials and warms the catalog, and the next request hits the chat endpoint directly.

### Option B — from the command line (headless / bootstrapping)

```bash
# Directly, no npm deps, Node >= 18 only:
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# Or via the package bin from the install directory:
cd ~/.dsh/profiles/web && pnpm exec codebuddy-login

# Add --no-browser on a remote server / headless box
```

The CLI only writes the credentials — the native adapter owns the route, so there is no settings route to manage; `--international` merely selects the OAuth endpoints the login itself uses.

## Uninstall

```bash
dsh plugin --profile web remove dsh-codebuddy-auth
```

This removes the dependency and takes the plugin back out of the profile layer stack. Restart DSH to unload it.

## International edition

The plugin targets the **China edition** by default (`copilot.tencent.com` / `www.codebuddy.cn`). Select the **international edition** (`www.codebuddy.ai`) through the mount row's `edition: intl` config:

```yaml
# your cordis.patch.yml mount row:
- id: codebuddy-auth
  name: dsh-codebuddy-auth
  edition: intl          # omitted = China edition
```

The adapter and the login/model-discovery endpoints then all use `www.codebuddy.ai`. The CLI's `--international` only selects the international OAuth endpoints for the login itself.

## Usage

- **Switch models**: pick any model under CodeBuddy in the model picker (e.g. `deepseek-v4-pro`)
- **Status**: "check codebuddy status" → the `codebuddy` tool's `status` action
- **Renewal (automatic, three layers)**: ① at every startup, the token is renewed when less than 5 minutes of validity remains (or it has already expired); ② while running, a check every 30 minutes renews whenever less than 1 hour remains — covering a long-lived dsh that never restarts; ③ if the refresh token itself is invalidated (password change / revocation), the first two layers fail and log it — then say "refresh codebuddy" to confirm, or log in again
- **Model updates**: after Tencent ships new models, say "sync codebuddy models" → `sync-models`
- **Logout**: "log out of codebuddy" → clears stored credentials

### Reasoning

Each model is declared with its **full real reasoning capability** from `/v3/config`, so the model picker shows the levels each model actually offers:

- **Selectable levels** (per model): `supportedEfforts` mirrors straight into the picker — `deepseek-v4-pro` offers `low` / `high` / `xhigh`, `hy3` offers `low` / `high`, fixed-effort models (e.g. `glm-5.1`) offer their single `medium`. Sent on the wire as `reasoning_effort: "<level>"`.
- **Default level**: each model uses the `defaultEffort` its `/v3/config` entry reports (e.g. `glm-5.2` defaults to `high`); every declared level stays selectable in the picker.

## Multi-account, credits & account switching

Every logged-in account lives in one `CODEBUDDY_ACCOUNTS` document in the credential store (a pre-0.9 single-token install is migrated in as account 0). All four switching behaviors are supported:

- **Auto-rotate on exhaustion**: when the active account hits QUOTA_EXCEEDED / RATE_LIMIT, it is put on cooldown and the request falls through to the next usable account.
- **Lock an account**: `lock` pins one account as active and disables auto-rotation off it (unlock before it can move).
- **Manual switch**: `activate <id>` sets the active account directly.
- **Skip unavailable accounts**: disabled, cooling, or token-less accounts are skipped during selection and rotation.

Credits are queried from `POST /v2/billing/meter/get-user-resource` (verified live): the remaining balance sums the non-expired `credits` packages' `CapacityRemain`. Three entry points:

- **Web UI (recommended)**: after restarting DSH, open `http://127.0.0.1:<web-port>/codebuddy` — account list + status + credits, in-page login, enable/disable/delete, import/export, model view/sync. Loopback-only (the routes manage tokens).
- **Agent**: say "codebuddy accounts" / "check codebuddy credits" / "switch to <id>" / "lock this account".
- **`codebuddy` tool**: `accounts` / `activate` / `lock` / `quota` / `status` actions.

## Files

- `lib/index.js` — the Cordis host plugin (composition row). Registers the `codebuddy` provider and tool, owns the account pool, and drives rotation + the 30-minute renewal/quota guard.
- `lib/codebuddy-adapter.mjs` — the native `ctx.llm` adapter (DSH 0.1.7 rc2 message model): SSE streaming, message serialization, reasoning metadata, error mapping, account-level failure callback. Ported from [shatyuka/dsh-llm-codebuddy](https://github.com/shatyuka/dsh-llm-codebuddy) (MIT).
- `lib/codebuddy-core.mjs` — OAuth, JWT decoding, CLI/craft identity headers, `/v3/config` discovery, `/v2/plugin/account` identity, and `/v2/billing/meter/get-user-resource` quota; dependency-free.
- `lib/accounts.mjs` — the multi-account pool (read-through storage, CRUD, activate, lock, enable, cooldown, rotation, import/export, legacy migration).
- `lib/runtime.mjs` — the shared operation layer both the tool and the web UI call (login/refresh/quota/sync/account control), so the two surfaces never drift.
- `lib/web.mjs` + `lib/web-ui.mjs` — the `dsh-codebuddy-auth/web` plugin: mounts the `/codebuddy` settings/login page via `ctx.webServer.register` (loopback).
- `bin/login-flow.mjs` — standalone login CLI (single-account bootstrap; its legacy tokens are adopted by the pool migration); no npm dependencies.
- `cordis.patch.yml` — in-package patch (mounts both the main plugin and the `/web` UI row).

## Known limitations (all verified empirically)

- `POST /v2/chat/completions` **does not check User-Agent** — any UA works; but the request must be `stream: true` (non-streaming returns `code 11101`). DSH's llm adapters are streaming by default, so nothing to handle.
- `GET /v3/config` (model discovery) requires the craft / VSCode identity (`X-Agent-Intent: craft` + `X-IDE-*` headers) to disclose reasoning metadata; the plugin sends its own direct request for that.
- CodeBuddy reports `supportsReasoning` on every craft model. Models are declared with their real reasoning capability (levels per `supportedEfforts`), so reasoning is selectable in the model picker rather than stripped.

## License

MIT
