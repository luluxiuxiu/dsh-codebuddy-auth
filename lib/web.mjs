/**
 * dsh-codebuddy-auth/web — the CodeBuddy settings & login UI, mounted as a
 * separate bundle row so headless profiles (no web server) leave it pending.
 *
 * Verified registration mechanism (from dsh-agy + the upstream
 * dsh-llm-codebuddy plugin): inject `webServer` and call
 * `ctx.webServer.register({ kind: 'exact', path, handler })`, where `handler`
 * is a Node-style `(req, res)`. Every route manages credentials, so all of
 * them stay loopback-only. The pool is shared with the main plugin through the
 * read-through credentials ref, so changes here take effect on the next request
 * without a restart.
 */
import { cfgForEdition } from './codebuddy-core.mjs';
import { AccountPool } from './accounts.mjs';
import { createRuntime } from './runtime.mjs';
import { renderSettingsPage } from './web-ui.mjs';

export const name = 'codebuddy-auth-web';
export const inject = ['credentials', 'webServer'];

const ROUTE = '/codebuddy';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/** Loopback + same-origin guard: these routes read/write account tokens. */
function localRequest(req) {
  const address = req.socket && req.socket.remoteAddress;
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

export function apply(ctx) {
  ctx.effect(async () => {
    const webServer = ctx.get('webServer');
    if (!webServer) return () => {};

    const pool = new AccountPool({ credentials: ctx.credentials, logger: ctx.logger });
    const runtime = createRuntime({ pool, defaultEdition: 'cn', logger: ctx.logger, onCatalogChanged: () => {} });
    // Logins started from the page, kept while the browser round-trip completes.
    const pending = new Map();

    const stateView = async () => {
      const status = await runtime.status();
      const active = status.active || null;
      return {
        accounts: status.accounts,
        activeId: active ? active.id : null,
        accountCount: status.accountCount,
        cliVersion: cfgForEdition('cn').cliVersion,
        models: active ? (await pool.load(), await modelCount()) : 0,
      };
    };
    async function modelCount() {
      const account = pool.active;
      if (!account) return 0;
      const { fetchRemoteModels } = await import('./codebuddy-core.mjs');
      try { return (await fetchRemoteModels(account.access, cfgForEdition(account.edition))).length; }
      catch { return 0; }
    }

    const routes = [];

    // ---- the settings page --------------------------------------------- //
    routes.push({
      kind: 'exact',
      path: ROUTE,
      handler: (_req, res) => sendHtml(res, 200, renderSettingsPage(ROUTE)),
    });

    // ---- read state ---------------------------------------------------- //
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/state`,
      handler: async (_req, res) => {
        try { sendJson(res, 200, { ok: true, ...(await stateView()) }); }
        catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });

    // ---- login: start then poll (CodeBuddy OAuth is poll-based, not redirect) //
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/login/start`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const body = await readBody(req);
          const auth = await runtime.startLogin({ edition: body.edition });
          pending.set(auth.state, { createdAt: Date.now(), edition: auth.edition });
          sendJson(res, 200, { ok: true, state: auth.state, url: auth.url, edition: auth.edition });
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/login/poll`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const body = await readBody(req);
          const entry = pending.get(body.state);
          if (!entry) return sendJson(res, 410, { ok: false, error: 'login session expired, start again' });
          if (Date.now() - entry.createdAt > 10 * 60 * 1000) { pending.delete(body.state); return sendJson(res, 410, { ok: false, error: 'login timed out' }); }
          const hit = await runtime.pollLogin(body.state, cfgForEdition(entry.edition));
          if (!hit) { sendJson(res, 200, { ok: true, done: false }); return; }
          const account = await runtime.completeLogin({ access: hit.accessToken, refresh: hit.refreshToken, edition: entry.edition });
          pending.delete(body.state);
          sendJson(res, 200, { ok: true, done: true, account });
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });

    // ---- account controls ---------------------------------------------- //
    const control = (path, fn) => routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/${path}`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const body = await readBody(req);
          const out = await fn(body);
          // Never echo the raw account object back (it holds access/refresh);
          // report status + the sanitized stateView instead.
          const { account, ...rest } = out || {};
          sendJson(res, out && out.ok === false ? 400 : 200, { ...rest, ...(await stateViewSafe()) });
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });
    async function stateViewSafe() { try { return await stateView(); } catch { return {}; } }

    control('activate', (b) => runtime.activate(b.id));
    control('lock', (b) => runtime.setLocked(b.id, b.lock !== false));
    control('enable', (b) => runtime.setEnabled(b.id, b.enabled !== false));
    control('remove', (b) => runtime.remove(b.id));
    control('refresh', (b) => runtime.refreshAccount(b.id));

    // ---- quota --------------------------------------------------------- //
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/quota`,
      handler: async (req, res) => {
        if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url || '', 'http://127.0.0.1');
          const id = url.searchParams.get('id') || undefined;
          const out = await runtime.quota(id, { force: true });
          sendJson(res, 200, out.ok ? { ok: true, quota: out.quota, accountId: out.accountId } : { ok: false, error: out.error });
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });

    // ---- models (view + sync) ------------------------------------------ //
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/models`,
      handler: async (_req, res) => {
        try {
          const out = await runtime.syncModels();
          sendJson(res, 200, out.ok ? { ok: true, models: out.models } : { ok: false, error: out.error });
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });

    // ---- export / import (loopback only; export carries tokens) -------- //
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/export`,
      handler: async (req, res) => {
        if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const doc = await runtime.exportAll();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="codebuddy-accounts.json"', 'cache-control': 'no-store' });
          res.end(JSON.stringify(doc, null, 2));
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });
    routes.push({
      kind: 'exact',
      path: `${ROUTE}/api/import`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const body = await readBody(req);
          const doc = body.doc || body;
          const out = await runtime.importDoc(doc);
          sendJson(res, out.ok ? 200 : 400, { ...out, ...(await stateViewSafe()) });
        } catch (error) { sendJson(res, 500, { ok: false, error: error.message }); }
      },
    });

    ctx.logger.info(`codebuddy-auth: web settings UI mounted at ${ROUTE} (loopback)`);
    const disposers = routes.map((route) => webServer.register(route));
    return () => { for (const dispose of disposers) { try { dispose(); } catch { /* idempotent */ } } };
  });
}
