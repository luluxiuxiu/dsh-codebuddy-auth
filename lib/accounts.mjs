/**
 * Multi-account pool for CodeBuddy. One credential ref (`CODEBUDDY_ACCOUNTS`)
 * holds a lossless JSON document of every logged-in account plus the active
 * selection; this mirrors how sibling DSH provider plugins (dsh-agy) model an
 * account pool — `enabled`/`locked`/`cooldownUntil`/`cachedQuota` per account —
 * and lets one DSH process juggle several CodeBuddy identities.
 *
 * Responsibilities kept here (single source of truth for the pool):
 *   - load/save + a legacy single-token migration (pre-0.9 refs);
 *   - add/activate/lock/enable/remove;
 *   - quota-exhaustion rotation and skip-unavailable selection;
 *   - per-account token + quota caching.
 *
 * Plain ESM, no dependencies, Node >= 18. Secrets (access/refresh) never leave
 * the store: `list()` is the sanitized view handed to the tool and the UI.
 */
import { cfgForEdition, fetchAccountInfo, fetchQuota, resolveUserId, tokenExpiresAt } from './codebuddy-core.mjs';

const POOL_REF = 'CODEBUDDY_ACCOUNTS';
// Pre-0.9 stored one flat token pair under these refs; migrate them in once.
const LEGACY_ACCESS_REF = 'CODEBUDDY_ACCESS_TOKEN';
const LEGACY_REFRESH_REF = 'CODEBUDDY_REFRESH_TOKEN';

function newId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Coerce an untrusted account entry into the canonical shape. */
function normalizeAccount(raw) {
  const access = typeof raw.access === 'string' ? raw.access : '';
  const expiresAt = Number.isFinite(raw.expiresAt) ? raw.expiresAt : (access ? tokenExpiresAt(access) : undefined);
  const uid = raw.uid || (access ? resolveUserId(access) : '') || '';
  return {
    id: raw.id || uid || newId(),
    edition: raw.edition === 'intl' ? 'intl' : 'cn',
    uid,
    nickname: typeof raw.nickname === 'string' ? raw.nickname : '',
    uin: typeof raw.uin === 'string' ? raw.uin : '',
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    accountType: typeof raw.accountType === 'string' ? raw.accountType : '',
    access,
    refresh: typeof raw.refresh === 'string' ? raw.refresh : '',
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : 0,
    enabled: raw.enabled !== false,
    locked: raw.locked === true,
    cooldownUntil: Number.isFinite(raw.cooldownUntil) ? raw.cooldownUntil : 0,
    cooldownReason: typeof raw.cooldownReason === 'string' ? raw.cooldownReason : '',
    quota: raw.quota && typeof raw.quota === 'object' ? raw.quota : null,
    quotaAt: Number.isFinite(raw.quotaAt) ? raw.quotaAt : 0,
  };
}

export class AccountPool {
  /**
   * @param {object} deps
   * @param {{ resolve: (ref:string)=>Promise<{value:string}|undefined>, set:(ref:string,value:string)=>Promise<unknown>, unset:(ref:string)=>Promise<unknown> }} deps.credentials
   * @param {{ warn?:Function, info?:Function }} [deps.logger]
   */
  constructor({ credentials, logger = console }) {
    this.credentials = credentials;
    this.logger = logger;
    this.state = { version: 1, activeId: '', accounts: [] };
    this.loaded = false;
    // Round-robin cursor so rotation walks the pool instead of always picking
    // the same next account.
    this.cursor = 0;
  }

  async readRef(ref) {
    try {
      const hit = await this.credentials.resolve(ref);
      return hit ? hit.value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Parse the stored document into canonical state (never throws). */
  parseDoc(text) {
    try {
      const doc = JSON.parse(text);
      const accounts = Array.isArray(doc.accounts) ? doc.accounts.map(normalizeAccount) : [];
      const activeId = typeof doc.activeId === 'string' && doc.activeId ? doc.activeId : (accounts[0]?.id || '');
      return { version: 1, activeId, accounts };
    } catch {
      return null;
    }
  }

  async load() {
    // Read-through: always re-read the persisted document so a mutation made by
    // the sibling web plugin (activate/lock/enable/import) is seen by the
    // adapter's next getAccessToken without a restart. The document is small and
    // credentials.resolve is already hit per request, so this is not hot-path I/O.
    const text = await this.readRef(POOL_REF);
    if (text) {
      const doc = this.parseDoc(text);
      if (doc && doc.accounts.length > 0) {
        this.state = doc;
        this.loaded = true;
        return this.state;
      }
    } else if (!this.loaded) {
      // First run under 0.9: fold any legacy single-token install into account 0.
      await this.migrateLegacy();
      this.loaded = true;
    }
    return this.state;
  }

  async migrateLegacy() {
    const access = await this.readRef(LEGACY_ACCESS_REF);
    if (!access) return;
    const refresh = (await this.readRef(LEGACY_REFRESH_REF)) || '';
    const account = normalizeAccount({ id: newId(), access, refresh, edition: 'cn' });
    const info = await fetchAccountInfo(access, cfgForEdition('cn')).catch(() => null);
    if (info) Object.assign(account, { uid: info.uid || account.uid, nickname: info.nickname, uin: info.uin, phone: info.phone, accountType: info.accountType });
    this.state = { version: 1, activeId: account.id, accounts: [account] };
    await this.save();
    // Retire the legacy refs so the old flat-token path cannot resurrect itself.
    await this.credentials.unset(LEGACY_ACCESS_REF).catch(() => {});
    await this.credentials.unset(LEGACY_REFRESH_REF).catch(() => {});
    this.logger.info?.('codebuddy-auth: migrated a legacy single-token login into the account pool');
  }

  async save() {
    try {
      await this.credentials.set(POOL_REF, JSON.stringify(this.state));
    } catch (error) {
      this.logger.warn?.(`codebuddy-auth: failed to persist the account pool (${error && error.message})`);
    }
  }

  // ---- read-only views ------------------------------------------------- //

  get all() { return this.state.accounts; }

  find(id) { return this.state.accounts.find((a) => a.id === id); }

  get active() {
    const accounts = this.state.accounts;
    if (accounts.length === 0) return null;
    return accounts.find((a) => a.id === this.state.activeId && this.available(a))
      || accounts.find((a) => this.available(a))
      || accounts.find((a) => a.id === this.state.activeId)
      || null;
  }

  /** An account can serve a request now: enabled, not cooling, token present. */
  available(account, now = Date.now()) {
    return !!account && account.enabled !== false
      && !(account.cooldownUntil && account.cooldownUntil > now)
      && typeof account.access === 'string' && account.access.length > 0;
  }

  cfg(account) { return cfgForEdition(account ? account.edition : 'cn'); }

  /** Sanitized list for the tool/UI: identity + state, never the tokens. */
  list(now = Date.now()) {
    return this.state.accounts.map((a) => ({
      id: a.id,
      edition: a.edition,
      nickname: a.nickname || '',
      uid: a.uid || '',
      phone: a.phone || '',
      accountType: a.accountType || '',
      active: a.id === this.state.activeId,
      locked: a.locked === true,
      enabled: a.enabled !== false,
      coolingUntil: a.cooldownUntil && a.cooldownUntil > now ? a.cooldownUntil : null,
      cooldownReason: a.cooldownUntil && a.cooldownUntil > now ? a.cooldownReason : '',
      expiresAt: a.expiresAt || null,
      expired: a.expiresAt ? a.expiresAt <= now : null,
      quota: a.quota || null,
      quotaAt: a.quotaAt || null,
    }));
  }

  // ---- mutations ------------------------------------------------------- //

  /** Add (or refresh in place, keyed by uid) an account from a token pair. */
  async upsert({ access, refresh, edition = 'cn' }) {
    await this.load();
    const cfg = cfgForEdition(edition);
    const uid = resolveUserId(access) || '';
    let account = uid ? this.state.accounts.find((a) => a.uid === uid && a.edition === edition) : undefined;
    const isNew = !account;
    if (!account) {
      account = normalizeAccount({ id: uid || newId(), edition });
      this.state.accounts.push(account);
    }
    account.access = access;
    account.refresh = refresh || account.refresh;
    account.expiresAt = tokenExpiresAt(access) || account.expiresAt;
    account.uid = uid || account.uid;
    account.cooldownUntil = 0;
    account.cooldownReason = '';
    const info = await fetchAccountInfo(access, cfg).catch(() => null);
    if (info) {
      account.nickname = info.nickname || account.nickname;
      account.uin = info.uin || account.uin;
      account.phone = info.phone || account.phone;
      account.accountType = info.accountType || account.accountType;
      account.uid = info.uid || account.uid;
    }
    // First account (or a fresh add while none is active) becomes active.
    if (!this.state.activeId || !this.find(this.state.activeId)) this.state.activeId = account.id;
    await this.save();
    return { account, isNew };
  }

  async activate(id) {
    await this.load();
    const account = this.find(id);
    if (!account) return { ok: false, error: `no such account: ${id}` };
    this.state.activeId = account.id;
    account.cooldownUntil = 0;
    account.cooldownReason = '';
    account.lastUsedAt = Date.now();
    await this.save();
    return { ok: true, account };
  }

  async setLocked(id, locked) {
    await this.load();
    const account = this.find(id);
    if (!account) return { ok: false, error: `no such account: ${id}` };
    account.locked = !!locked;
    // Locking is only meaningful for the account actually serving traffic, so
    // locking a non-active account also selects it — that is the user intent.
    if (locked) this.state.activeId = account.id;
    await this.save();
    return { ok: true, account };
  }

  async setEnabled(id, enabled) {
    await this.load();
    const account = this.find(id);
    if (!account) return { ok: false, error: `no such account: ${id}` };
    account.enabled = !!enabled;
    if (account.enabled) { account.cooldownUntil = 0; account.cooldownReason = ''; }
    // Disabling the active account must not leave the pool with nothing active.
    if (!account.enabled && this.state.activeId === account.id) {
      const next = this.nextCandidate(account.id);
      this.state.activeId = next ? next.id : '';
    }
    await this.save();
    return { ok: true, account };
  }

  async remove(id) {
    await this.load();
    const index = this.state.accounts.findIndex((a) => a.id === id);
    if (index < 0) return { ok: false, error: `no such account: ${id}` };
    this.state.accounts.splice(index, 1);
    if (this.state.activeId === id) {
      const next = this.state.accounts.find((a) => this.available(a)) || this.state.accounts[0];
      this.state.activeId = next ? next.id : '';
    }
    await this.save();
    return { ok: true, remaining: this.state.accounts.length };
  }

  updateTokens(id, { access, refresh, expiresAt }) {
    const account = this.find(id);
    if (!account) return;
    if (access) account.access = access;
    if (refresh) account.refresh = refresh;
    const nextExpiry = expiresAt || (access ? tokenExpiresAt(access) : undefined);
    if (Number.isFinite(nextExpiry)) account.expiresAt = nextExpiry;
  }

  cacheQuota(id, quota) {
    const account = this.find(id);
    if (!account || !quota) return;
    account.quota = { remaining: quota.remaining, used: quota.used, total: quota.total, exhausted: quota.exhausted, checkedAt: quota.checkedAt };
    account.quotaAt = quota.checkedAt || Date.now();
  }

  async setCooldown(id, until, reason) {
    await this.load();
    const account = this.find(id);
    if (!account) return;
    account.cooldownUntil = until;
    account.cooldownReason = reason || '';
    await this.save();
  }

  async clearCooldown(id) {
    await this.setCooldown(id, 0, '');
  }

  /** Next usable account after `fromId`, wrapping around; null when none. */
  nextCandidate(fromId, now = Date.now()) {
    const pool = this.state.accounts.filter((a) => this.available(a, now) && a.id !== fromId);
    if (pool.length === 0) return null;
    const all = this.state.accounts;
    const startIndex = Math.max(0, all.findIndex((a) => a.id === fromId));
    // Walk forward from the current position and take the first usable match.
    for (let step = 1; step <= all.length; step++) {
      const candidate = all[(startIndex + step) % all.length];
      if (candidate && this.available(candidate, now) && candidate.id !== fromId) return candidate;
    }
    return pool[0];
  }

  /**
   * Rotate to the next usable account. A locked active account is never moved
   * off (the user pinned it), so rotation returns it unchanged. Returns the new
   * active account, or null when the whole pool is unusable.
   */
  async rotate(reason = 'quota') {
    await this.load();
    const current = this.active;
    if (!current) return null;
    if (current.locked) return current;
    current.cooldownUntil = Date.now() + this.cooldownMs(reason);
    current.cooldownReason = reason;
    const next = this.nextCandidate(current.id);
    if (!next) { await this.save(); return null; }
    this.state.activeId = next.id;
    next.lastUsedAt = Date.now();
    await this.save();
    this.logger.info?.(`codebuddy-auth: rotated active account off "${current.nickname || current.uid}" (${reason}) -> "${next.nickname || next.uid}"`);
    return next;
  }

  /** Cooling windows differ by cause: quota exhaustion parks until the next
   *  cycle is far out, a transient 429 clears quickly, an auth failure parks
   *  until a human re-logins (long). */
  cooldownMs(reason) {
    switch (reason) {
      case 'rate-limit': return 60 * 1000;
      case 'auth': return 6 * 60 * 60 * 1000;
      case 'quota': return 30 * 60 * 1000;
      default: return 5 * 60 * 1000;
    }
  }

  // ---- import / export ------------------------------------------------- //

  export() {
    return { version: 1, exportedAt: Date.now(), activeId: this.state.activeId, accounts: this.state.accounts.map((a) => ({ ...a })) };
  }

  async import(doc) {
    await this.load();
    const incoming = doc && Array.isArray(doc.accounts) ? doc.accounts : [];
    let added = 0;
    let updated = 0;
    for (const raw of incoming) {
      const account = normalizeAccount(raw);
      if (!account.access) continue;
      const existing = account.uid ? this.state.accounts.find((a) => a.uid === account.uid && a.edition === account.edition) : this.find(account.id);
      if (existing) { Object.assign(existing, account, { id: existing.id }); updated += 1; }
      else { this.state.accounts.push(account); added += 1; }
    }
    if (!this.state.activeId || !this.find(this.state.activeId)) {
      const first = this.state.accounts.find((a) => this.available(a)) || this.state.accounts[0];
      if (first) this.state.activeId = first.id;
    }
    await this.save();
    return { ok: true, added, updated, total: this.state.accounts.length };
  }

  async clearAll() {
    this.state = { version: 1, activeId: '', accounts: [] };
    await this.save();
  }
}

export { POOL_REF };
