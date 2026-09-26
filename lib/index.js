/**
 * dsh-codebuddy-auth — CodeBuddy (Tencent IOA) as a native DSH llm provider.
 * Registers a `codebuddy` adapter on ctx.llm (own chat wire, CLI identity), the
 * `codebuddy` tool (multi-account login/status/refresh/rotate/quota/logout/
 * sync-models), an account pool with per-account auto-refresh, and editions
 * (China default; per-account `intl`; mount-row `edition: intl` sets default).
 */
import { exec as nodeExec } from 'node:child_process';
import { cfgForEdition, identityHeaders, fetchRemoteModels } from './codebuddy-core.mjs';
import { CodebuddyAdapter } from './codebuddy-adapter.mjs';
import { AccountPool } from './accounts.mjs';
import { createRuntime } from './runtime.mjs';

export const name = 'codebuddy-auth';
export const inject = ['llm', 'tools', 'credentials', 'settings'];

const NS_LEGACY = 'llm-pi-ai';

function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? `open "${url}"`
      : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    nodeExec(cmd, () => {});
  } catch {
    // best effort only; the URL is always returned for manual use
  }
}

/** Drop `undefined` properties (a tool's value must be lossless JSON). */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = prune(entry);
    }
    return out;
  }
  return value;
}

export async function apply(ctx, config = {}) {
  let live = true;
  ctx.effect(() => () => { live = false; });

  const defaultEdition = config.edition === 'intl' ? 'intl' : 'cn';

  const pool = new AccountPool({ credentials: ctx.credentials, logger: ctx.logger });
  // Snapshot the active account during getAccessToken so connection() (sync) can
  // describe the same account's edition/endpoint the token came from.
  let active = null;

  const adapter = new CodebuddyAdapter({
    getAccessToken: async () => {
      await pool.load();
      active = pool.active;
      return active ? active.access : undefined;
    },
    connection: () => {
      const cfg = cfgForEdition((active && active.edition) || defaultEdition);
      return { chatBaseURL: cfg.chatBaseURL, domain: cfg.domain, cliVersion: cfg.cliVersion, product: cfg.product };
    },
    readCatalog: async () => {
      await pool.load();
      const account = pool.active;
      if (!account) throw new Error('not logged in');
      return fetchRemoteModels(account.access, cfgForEdition(account.edition || defaultEdition));
    },
    identityFromToken: identityHeaders,
    onGatewayError: (code) => { void runtime.handleGatewayError(code); },
  });

  const runtime = createRuntime({
    pool,
    defaultEdition,
    logger: ctx.logger,
    onCatalogChanged: () => adapter.refreshCatalog(),
  });

  // Pre-0.7 installs left a llm-pi-ai settings route; a stale one would make
  // registerAdapter throw DUPLICATE_ADAPTER. Await the unset before registering.
  async function migrateLegacyRoute() {
    try {
      const section = ctx.settings.get(NS_LEGACY);
      if (section && section.providers && section.providers.codebuddy !== undefined) {
        await ctx.settings.mutate(NS_LEGACY, [{ op: 'unset', path: ['providers', 'codebuddy'] }]);
      }
    } catch {
      // settings namespace absent
    }
  }

  await migrateLegacyRoute();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ctx.llm.registerAdapter(['codebuddy'], adapter);
      break;
    } catch (error) {
      if (!error || (error.code !== 'DUPLICATE_ADAPTER' && !/already registered/.test(String(error.message)))) throw error;
      if (attempt === 3) ctx.logger.warn('codebuddy-auth: another adapter already serves the codebuddy provider; not registering ours');
      else await sleep(150);
    }
  }

  ctx.tools.register({
    name: 'codebuddy',
    description:
      'Manage the CodeBuddy (Tencent IOA) model provider and its account pool: browser OAuth login, token refresh, '
      + 'multi-account list/switch/lock, remaining-credit quota, model-list sync, and logout. '
      + 'Use action "login" to start (returns a URL to open), "accounts" to inspect the pool, "activate"/"lock" to steer it, '
      + '"quota" to check credits, "status" for state, "refresh" after expiry, "sync-models" to re-pull the catalog, "logout" to clear.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['login', 'status', 'refresh', 'logout', 'sync-models', 'accounts', 'activate', 'lock', 'quota'],
          description: 'login: start browser OAuth and wait; accounts: list the pool; activate: set the active account by id; '
            + 'lock: pin (or unpin) an account so auto-rotation skips it; quota: query remaining credits; status: pool + active state; '
            + 'refresh: rotate an access token; logout: clear the whole pool; sync-models: re-pull the /v3/config catalog.',
        },
        accountId: {
          type: 'string',
          description: 'Target account id for activate/lock/refresh/quota. Defaults to the active account when omitted.',
        },
        lock: {
          type: 'boolean',
          description: 'For action "lock": true pins the account to active (disables auto-rotation off it), false releases the pin.',
        },
        edition: {
          type: 'string',
          enum: ['cn', 'intl'],
          description: 'For action "login": which edition to authenticate against (defaults to the mount-row edition).',
        },
        waitSeconds: {
          type: 'integer',
          description: 'How long action "login" waits for the browser flow inside this call (default 90, max 300). If it expires, call login again to keep waiting.',
        },
        openBrowser: {
          type: 'boolean',
          description: 'Try to open the login URL in the desktop browser (default true).',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'ok'],
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          authUrl: { type: 'string' },
          state: { type: 'string' },
          pending: { type: 'boolean' },
          error: { type: 'string' },
          result: { type: 'object' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `codebuddy ${value.action}: ${value.ok ? 'ok' : 'failed'}${value.pending ? ' (pending browser login)' : ''}${value.authUrl ? `\nlogin URL: ${value.authUrl}` : ''}${value.error ? `\nerror: ${value.error}` : ''}${value.result ? `\n${JSON.stringify(value.result, null, 2)}` : ''}`,
      }],
    },
    async execute(args, exec) {
      return prune(await runAction(args, exec));
    },
  });

  const runAction = async (args, exec) => {
    const action = args.action;
    try {
      if (action === 'login') {
        const auth = await runtime.startLogin({ edition: args.edition });
        const waitMs = Math.min(Math.max(args.waitSeconds ?? 90, 5), 300) * 1000;
        if (args.openBrowser !== false) openBrowser(auth.url);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && live && !(exec.signal && exec.signal.aborted)) {
          await sleep(3000);
          const hit = await runtime.pollLogin(auth.state, auth.cfg).catch(() => null);
          if (hit) {
            return { action, ok: true, result: await runtime.completeLogin({ access: hit.accessToken, refresh: hit.refreshToken, edition: auth.edition }) };
          }
        }
        return {
          action,
          ok: true,
          pending: true,
          state: auth.state,
          authUrl: auth.url,
          result: { note: 'waiting for browser login; call login again to continue waiting' },
        };
      }
      if (action === 'accounts') {
        const status = await runtime.status();
        return { action, ok: true, result: { accounts: status.accounts, activeId: status.active && status.active.id } };
      }
      if (action === 'activate') {
        if (!args.accountId) return { action, ok: false, error: 'accountId is required for activate' };
        const out = await runtime.activate(args.accountId);
        return out.ok ? { action, ok: true, result: { activated: out.account.id, nickname: out.account.nickname } } : { action, ...out };
      }
      if (action === 'lock') {
        if (!args.accountId) return { action, ok: false, error: 'accountId is required for lock' };
        const out = await runtime.setLocked(args.accountId, args.lock !== false);
        return out.ok ? { action, ok: true, result: { accountId: out.account.id, locked: out.account.locked, activeId: pool.state.activeId } } : { action, ...out };
      }
      if (action === 'quota') {
        const out = await runtime.quota(args.accountId, { force: true });
        return { action, ok: out.ok, error: out.error, result: out.quota ? { accountId: out.accountId, ...out.quota } : undefined };
      }
      if (action === 'status') {
        const status = await runtime.status();
        const modelCount = (await adapter.listModels('codebuddy').catch(() => [])).length;
        return { action, ok: true, result: { ...status, modelCount } };
      }
      if (action === 'refresh') {
        const out = await runtime.refreshAccount(args.accountId);
        return out.ok ? { action, ok: true, result: out } : { action, ...out };
      }
      if (action === 'logout') {
        if (args.accountId) { await runtime.remove(args.accountId); return { action, ok: true, result: { note: `removed account ${args.accountId}` } }; }
        await runtime.logoutAll();
        return { action, ok: true, result: { note: 'account pool cleared' } };
      }
      if (action === 'sync-models') {
        const out = await runtime.syncModels();
        return { action, ok: out.ok, error: out.error, result: { modelNote: out.ok ? `synced ${out.modelCount} models (${(out.models || []).join(', ')})` : undefined } };
      }
      return { action, ok: false, error: `unknown action "${action}"` };
    } catch (error) {
      return { action, ok: false, error: error.message };
    }
  };

  // Startup: refresh the active token if needed, then report catalog state.
  void (async () => {
    if (!live) return;
    try {
      await pool.load();
      const account = pool.active;
      if (account) {
        const out = await runtime.refreshActiveIfNeeded(5 * 60 * 1000);
        if (!out.skipped) ctx.logger.info(`codebuddy-auth: startup refresh ${out.ok ? 'succeeded' : `failed: ${out.error}`}`);
        adapter.refreshCatalog();
        const count = (await adapter.listModels('codebuddy').catch(() => [])).length;
        ctx.logger.info(`codebuddy-auth: adapter ready (${pool.state.accounts.length} accounts, ${count} models)`);
      } else {
        ctx.logger.info('codebuddy-auth: adapter mounted (log in to populate the account pool)');
      }
    } catch (error) {
      ctx.logger.warn(`codebuddy-auth: startup pass skipped (${error.message})`);
    }
  })();

  // Periodic guard: rotate the active token before it expires, and refresh the
  // remaining-credit reading so a fully-exhausted active account rotates to the
  // next usable one before the next request pays the latency.
  const CHECK_MS = 30 * 60 * 1000;
  const EXPIRY_MARGIN_MS = 60 * 60 * 1000;
  let busy = false;
  const guard = async () => {
    if (!live || busy) return;
    busy = true;
    try {
      await pool.load();
      const account = pool.active;
      if (!account) return;
      // Clear a lapsed cooldown so a previously-throttled account becomes eligible again.
      for (const a of pool.state.accounts) {
        if (a.cooldownUntil && a.cooldownUntil <= Date.now()) { a.cooldownUntil = 0; a.cooldownReason = ''; }
      }
      if (!account.expiresAt || account.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) {
        const out = await runtime.refreshAccount(account.id);
        if (out.ok) ctx.logger.info('codebuddy-auth: proactive token refresh succeeded');
        else ctx.logger.warn(`codebuddy-auth: proactive refresh failed (${out.error})`);
      }
      const q = await runtime.quota(account.id);
      if (q.ok && q.quota && q.quota.exhausted && !account.locked) {
        ctx.logger.warn(`codebuddy-auth: active account "${account.nickname || account.uid}" is out of credits — rotating to the next account`);
        await runtime.handleGatewayError('QUOTA_EXCEEDED');
      }
    } catch (error) {
      ctx.logger.warn(`codebuddy-auth: guard pass skipped (${error.message})`);
    } finally {
      busy = false;
    }
  };
  const timer = typeof ctx.get === 'function' ? ctx.get('timer') : undefined;
  if (timer && typeof timer.interval === 'function') {
    ctx.effect(() => timer.interval(guard, CHECK_MS));
  } else {
    const handle = setInterval(guard, CHECK_MS);
    if (typeof handle.unref === 'function') handle.unref();
    ctx.effect(() => clearInterval(handle));
  }
}

// Local sleep avoids importing the whole core graph just for this.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
