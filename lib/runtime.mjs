/**
 * Shared CodeBuddy runtime: the account/token/quota operations both the
 * in-harness `codebuddy` tool (lib/index.js) and the web settings UI
 * (lib/web.mjs) call, so the two surfaces can never drift. Depends only on an
 * AccountPool + the stateless core helpers.
 *
 * Two plugin fibers each build their own runtime over the SAME credentials
 * service; the pool is read-through, so a mutation from one surface is visible
 * to the other on the next operation.
 */
import {
  CLIENT_PROFILES,
  cfgForEdition,
  clientProfileOf,
  requestAuthState,
  pollTokenOnce,
  refreshAccessToken,
  identityHeaders,
  tokenExpiresAt,
  fetchRemoteModels,
  fetchQuota,
} from './codebuddy-core.mjs';
import { readClientChoice, saveClientChoice } from './client-profile.mjs';

/**
 * @param {object} deps
 * @param {object} deps.pool — AccountPool; it owns the live client identity, so
 *   a switch made in one fiber is picked up by every pooled call in that fiber.
 * @param {string} [deps.defaultClient] — initial identity when nothing is stored
 *   (`config.client` / `CODEBUDDY_CLIENT`).
 */
export function createRuntime({ pool, defaultEdition = 'cn', defaultClient, logger = console, onCatalogChanged }) {
  if (defaultClient && typeof pool.setClient === 'function') pool.setClient(defaultClient);
  // Always read the identity from the pool, never from a captured constant: the
  // panel can switch it at runtime.
  const cfgFor = (account) => cfgForEdition((account && account.edition) || defaultEdition, pool.client);

  async function activeAccount() {
    await pool.load();
    return pool.active;
  }

  /** 把 credentials 里持久化的选择同步到本 fiber 的 pool（跨 fiber，3s 内收敛）。 */
  async function syncClient() {
    const next = await readClientChoice(pool.credentials, { fallback: pool.client });
    if (next !== pool.client) pool.setClient(next);
    return next;
  }

  /** 当前身份的可读描述（面板与工具共用）。 */
  function clientInfo() {
    const cfg = cfgForEdition(defaultEdition, pool.client);
    const profile = clientProfileOf(cfg);
    return {
      client: profile.id,
      label: profile.label,
      platform: profile.platform,
      ideType: profile.ideType,
      version: profile.version,
      productVersion: profile.productVersion,
      authPlatform: profile.authPlatform,
      userAgent: `${profile.platform}/${profile.version} ${profile.productName}/${profile.productVersion}`,
      options: Object.values(CLIENT_PROFILES).map((p) => ({ id: p.id, label: p.label })),
    };
  }

  /** 切换出站身份并持久化；所有后续请求（含登录握手）立即按新身份走。 */
  async function setClient(value) {
    const chosen = String(value || '').trim().toLowerCase();
    if (!CLIENT_PROFILES[chosen]) {
      throw new Error(`unknown client "${value}" (expected ide / vscode / cli)`);
    }
    const resolved = await saveClientChoice(pool.credentials, chosen);
    pool.setClient(resolved);
    // 目录只认 UA 品牌段、与身份无关，但账户/配额视图会跟着变，顺手清缓存。
    if (onCatalogChanged) onCatalogChanged();
    logger.info?.(`codebuddy-auth: outbound client -> ${resolved} (${CLIENT_PROFILES[resolved].label})`);
    return clientInfo();
  }

  /** Begin a browser OAuth login for `edition`; returns the state + URL.
   *
   *  The handshake carries the client profile's `platform` (IDE by default), so
   *  a freshly registered credential is NOT filed as a CLI client. */
  async function startLogin({ edition } = {}) {
    await syncClient();
    const cfg = cfgForEdition(edition || defaultEdition, pool.client);
    const authState = await requestAuthState(cfg);
    return { ...authState, cfg, edition: edition || defaultEdition };
  }

  /** One poll attempt for a started login. Returns the token blob or null. */
  async function pollLogin(state, cfg) {
    return pollTokenOnce(state, cfg);
  }

  /** Persist a completed login into the pool and warm the model catalog. */
  async function completeLogin({ access, refresh, edition }) {
    const { account, isNew } = await pool.upsert({ access, refresh: refresh || '', edition });
    // A fresh account may expose a different model set; drop the catalog cache.
    if (onCatalogChanged) onCatalogChanged();
    const expires = account.expiresAt || tokenExpiresAt(access);
    return {
      ok: true,
      accountId: account.id,
      isNew,
      edition: account.edition,
      nickname: account.nickname || '',
      uid: account.uid || '',
      expiresAt: expires || undefined,
      refreshToken: account.refresh ? 'stored' : 'none returned by server',
      identity: identityHeaders(access),
    };
  }

  /** Rotate one account's access token via its stored refresh token. */
  async function refreshAccount(id) {
    await pool.load();
    const account = id ? pool.find(id) : pool.active;
    if (!account) return { ok: false, error: 'no such account' };
    if (!account.refresh) return { ok: false, error: 'no refresh token stored; log in again' };
    const tokens = await refreshAccessToken(account.refresh, cfgFor(account));
    if (!tokens || !tokens.accessToken) {
      return { ok: false, error: 'refresh rejected; log in again in a browser' };
    }
    pool.updateTokens(account.id, {
      access: tokens.accessToken,
      refresh: tokens.refreshToken || account.refresh,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : tokenExpiresAt(tokens.accessToken),
    });
    await pool.save();
    if (onCatalogChanged) onCatalogChanged();
    return { ok: true, accountId: account.id, expiresAt: account.expiresAt };
  }

  /** Refresh the active account only when its token is close to expiry. */
  async function refreshActiveIfNeeded(marginMs) {
    const account = await activeAccount();
    if (!account) return { skipped: true, reason: 'no active account' };
    const expiresAt = account.expiresAt;
    if (expiresAt && expiresAt > Date.now() + marginMs) return { skipped: true, reason: 'token still fresh' };
    return refreshAccount(account.id);
  }

  /** Pull + cache the remaining-credit quota for one (or the active) account. */
  async function quota(id, { force = false } = {}) {
    await pool.load();
    const account = id ? pool.find(id) : pool.active;
    if (!account) return { ok: false, error: 'no such account' };
    if (!force && account.quota && Date.now() - account.quotaAt < 60 * 1000) {
      return { ok: true, accountId: account.id, cached: true, quota: account.quota };
    }
    const q = await fetchQuota(account.access, cfgFor(account));
    if (!q) return { ok: false, error: 'quota endpoint unreachable or unexpected shape' };
    pool.cacheQuota(account.id, q);
    await pool.save();
    return { ok: true, accountId: account.id, nickname: account.nickname || account.uid, quota: q };
  }

  /** Refresh the catalog and return how many models the active account offers. */
  async function syncModels() {
    if (onCatalogChanged) onCatalogChanged();
    const account = await activeAccount();
    if (!account) return { ok: false, error: 'not logged in', modelCount: 0 };
    try {
      const models = await fetchRemoteModels(account.access, cfgFor(account));
      return { ok: true, modelCount: models.length, models: models.map((m) => m.id) };
    } catch (error) {
      return { ok: false, error: error.message, modelCount: 0 };
    }
  }

  /** Sanitized pool view plus the active account's expiry/catalog facts. */
  async function status() {
    await syncClient();
    await pool.load();
    const accounts = pool.list();
    const active = accounts.find((a) => a.active) || null;
    const identity = clientInfo();
    return {
      ok: true,
      edition: defaultEdition,
      client: identity.client,
      identity,
      accounts,
      accountCount: accounts.length,
      active,
    };
  }

  // ---- pool mutators surfaced for the tool + UI ------------------------ //

  async function activate(id) { await pool.load(); return pool.activate(id); }
  async function setLocked(id, locked) { await pool.load(); return pool.setLocked(id, locked); }
  async function setEnabled(id, enabled) { await pool.load(); return pool.setEnabled(id, enabled); }
  async function remove(id) { await pool.load(); const out = await pool.remove(id); if (onCatalogChanged) onCatalogChanged(); return out; }
  async function logoutAll() { await pool.clearAll(); if (onCatalogChanged) onCatalogChanged(); return { ok: true }; }
  async function exportAll() { await pool.load(); return pool.export(); }
  async function importDoc(doc) { const out = await pool.import(doc); if (onCatalogChanged) onCatalogChanged(); return out; }

  /**
   * Rotate off the current account after an account-level failure (out of
   * credit / throttled). Clears any stale catalog so the next request re-reads
   * under the new account.
   */
  async function handleGatewayError(code) {
    const reason = code === 'RATE_LIMIT' ? 'rate-limit' : 'quota';
    await pool.load();
    const current = pool.active;
    if (!current || current.locked) return null; // pinned: nothing to do
    const next = await pool.rotate(reason);
    if (next && onCatalogChanged) onCatalogChanged();
    return next;
  }

  return {
    pool,
    cfgFor,
    activeAccount,
    clientInfo,
    setClient,
    syncClient,
    startLogin,
    pollLogin,
    completeLogin,
    refreshAccount,
    refreshActiveIfNeeded,
    quota,
    syncModels,
    status,
    activate,
    setLocked,
    setEnabled,
    remove,
    logoutAll,
    exportAll,
    importDoc,
    handleGatewayError,
  };
}
