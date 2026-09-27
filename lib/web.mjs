/**
 * dsh-codebuddy-auth/web — the host half of the CodeBuddy settings panel,
 * mounted as a separate bundle row so headless profiles (no connection channel)
 * leave it pending.
 *
 * Modeled on dsh-cline-pass/lib/panel.js: instead of registering many bare
 * webServer routes (each reachable by anything that can hit the port), this
 * publishes ONE dispatch route inside Connection's authenticated `/api` prefix
 * via `connection.fetch.register`. Joining that prefix inherits the Host/Origin
 * fence and browser-cookie auth for free — no manual loopback guard, no extra
 * surface. Every action crosses as `{ endpoint, payload }` and answers
 * `{ ok, value } | { ok:false, error }`; only lossless JSON crosses, and the
 * account pool is projected through sanitized views (tokens never leave).
 *
 * The panel is a thin projection over the shared runtime (lib/runtime.mjs), the
 * same operations the `codebuddy` tool drives — one source of truth.
 */
import { cfgForEdition, fetchRemoteModels } from './codebuddy-core.mjs';
import { AccountPool } from './accounts.mjs';
import { createRuntime } from './runtime.mjs';

export const name = 'codebuddy-auth-web';
// `connection` is injected lazily inside apply (it activates after the web
// server), so only credentials are declared up front.
export const inject = ['credentials'];

/** The exact `/api` route this package owns (Connection applies the fence). */
export const PANEL_PATH = '/api/codebuddy';
/** RPC failure code shared by every endpoint of this channel. */
const PANEL_ERROR_CODE = 'codebuddy/panel';

export function apply(ctx) {
  const pool = new AccountPool({ credentials: ctx.credentials, logger: ctx.logger });
  const runtime = createRuntime({ pool, defaultEdition: 'cn', logger: ctx.logger, onCatalogChanged: () => {} });
  // Logins started from the panel, kept while the browser round-trip completes.
  const pending = new Map();

  async function stateView() {
    const status = await runtime.status();
    const active = status.active || null;
    let models = 0;
    if (active) {
      try { models = (await fetchRemoteModels(active.access, cfgForEdition(active.edition))).length; } catch { models = 0; }
    }
    return {
      accounts: status.accounts,
      activeId: active ? active.id : null,
      accountCount: status.accountCount,
      cliVersion: cfgForEdition('cn').cliVersion,
      models,
    };
  }

  /** The endpoint table: name -> (payload) => Promise<lossless-json>. */
  const endpoints = {
    state: () => stateView(),
    async 'login.start'(payload) {
      const auth = await runtime.startLogin({ edition: payload.edition });
      pending.set(auth.state, { createdAt: Date.now(), edition: auth.edition });
      return { state: auth.state, url: auth.url, edition: auth.edition };
    },
    async 'login.poll'(payload) {
      const entry = pending.get(String(payload.state || ''));
      if (!entry) throw new Error('登录会话已过期，请重新开始');
      if (Date.now() - entry.createdAt > 10 * 60 * 1000) { pending.delete(payload.state); throw new Error('登录超时'); }
      const hit = await runtime.pollLogin(String(payload.state), cfgForEdition(entry.edition));
      if (!hit) return { done: false };
      const account = await runtime.completeLogin({ access: hit.accessToken, refresh: hit.refreshToken, edition: entry.edition });
      pending.delete(payload.state);
      return { done: true, account, ...(await stateView()) };
    },
    async activate(payload) { const out = await runtime.activate(payload.id); if (out.ok === false) throw new Error(out.error); return stateView(); },
    async lock(payload) { const out = await runtime.setLocked(payload.id, payload.lock !== false); if (out.ok === false) throw new Error(out.error); return stateView(); },
    async enable(payload) { const out = await runtime.setEnabled(payload.id, payload.enabled !== false); if (out.ok === false) throw new Error(out.error); return stateView(); },
    async remove(payload) { const out = await runtime.remove(payload.id); if (out.ok === false) throw new Error(out.error); return stateView(); },
    async refresh(payload) { const out = await runtime.refreshAccount(payload.id); if (out.ok === false) throw new Error(out.error); return stateView(); },
    async quota(payload) {
      const out = await runtime.quota(payload.id, { force: true });
      if (out.ok === false) throw new Error(out.error);
      return { accountId: out.accountId, quota: out.quota };
    },
    async models() { const out = await runtime.syncModels(); if (out.ok === false) throw new Error(out.error); return { models: out.models }; },
    'export'() { return runtime.exportAll(); },
    async import(payload) {
      const doc = payload.doc || payload;
      const out = await runtime.importDoc(doc);
      if (out.ok === false) throw new Error(out.error);
      return { added: out.added, updated: out.updated, total: out.total, ...(await stateView()) };
    },
  };

  // Register inside an effect so a hot-reload / fiber teardown withdraws the
  // route cleanly (ctx.inject returns the register disposer as its cleanup).
  ctx.effect(() => ctx.inject(['connection'], (connectionCtx) => connectionCtx.connection.fetch.register({
    path: PANEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: { code: PANEL_ERROR_CODE, message: '请求体不是 JSON' } }, { status: 400, headers: { 'cache-control': 'no-store' } });
      }
      const endpoint = String(body?.endpoint || '');
      const route = endpoints[endpoint];
      if (route === undefined) {
        return Response.json({ ok: false, error: { code: PANEL_ERROR_CODE, message: `未知的面板动作 ${JSON.stringify(endpoint)}` } }, { headers: { 'cache-control': 'no-store' } });
      }
      try {
        return Response.json({ ok: true, value: await route(body?.payload || {}) }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return Response.json({ ok: false, error: { code: PANEL_ERROR_CODE, message: String(error?.message || error).slice(0, 400) } }, { headers: { 'cache-control': 'no-store' } });
      }
    },
  })));
  ctx.logger.info(`codebuddy-auth: settings panel route ${PANEL_PATH} published (Connection-authenticated)`);
}
