/**
 * Core CodeBuddy (Tencent IOA) OAuth + API helpers, shared by the plugin
 * (lib/index.js + lib/codebuddy-adapter.mjs) and the standalone login CLI
 * (bin/login-flow.mjs). Plain ESM, Node >= 18.
 *
 * Every request speaks as an official CodeBuddy client (see CLIENT_PROFILES);
 * the default is the desktop IDE, and the CLI identity is still selectable.
 */
import { randomUUID } from 'node:crypto';

/** The two service editions: endpoints for OAuth + /v3/config + chat.
 *  The plugin's edition comes from its mount-row config (`edition: intl`);
 *  the CLI picks it with --international. */
export const EDITIONS = {
  cn: {
    label: 'China',
    serverUrl: 'https://copilot.tencent.com',
    domain: 'www.codebuddy.cn',
    chatBaseURL: 'https://copilot.tencent.com/v2',
  },
  intl: {
    label: 'International',
    serverUrl: 'https://www.codebuddy.ai',
    domain: 'www.codebuddy.ai',
    chatBaseURL: 'https://www.codebuddy.ai/v2',
  },
};

/** Versions, endpoints and the client-identity table. Bump versions here only.
 *
 *  Upstream decides "which client is this" from TWO places; changing one alone
 *  does nothing:
 *
 *    1. the OAuth handshake `POST /v2/plugin/auth/state?platform=<value>` —
 *       it is what gets *registered* for the credential. The official IDE
 *       sends `authentication.attributes.platform` from its product.json
 *       ("ide"); the CLI sends the top-level `platform` ("CLI").
 *    2. every request's User-Agent + X-IDE-* / X-Product-Version.
 *
 *  Values below are read off the official CodeBuddy CN desktop IDE (1.106.1,
 *  `resources/app`), 2026-10-18:
 *
 *    resources/app/product.json              genieVersion "4.12.2"
 *    extensions/genie/product.json           platform "CodeBuddyIDE",
 *                                            productName "CodeBuddy",
 *                                            deploymentType "SaaS",
 *                                            authentication.attributes.platform "ide"
 *    UserAgentHttpInterceptor.buildUserAgent `${platform}/${platformVersion} ` +
 *                                            `${productName}/${productVersion}`
 *    PluginClientInfoProvider.initClientInfo platformVersion = productVersion =
 *                                            genieVersion (falls back to the
 *                                            VSCode version / extension version)
 *    CustomHeadersHttpProxyInterceptor       X-IDE-Type (= getIDEType(platform)),
 *                                            X-IDE-Name (= platform),
 *                                            X-IDE-Version, X-Product-Version,
 *                                            X-Request-Trace-Id on every request
 *    getIDEType("CodeBuddyIDE")              "CodeBuddyIDE"
 *
 *  So the IDE wire identity is `CodeBuddyIDE/4.12.2 CodeBuddy/4.12.2` with
 *  X-IDE-Type and X-IDE-Name both `CodeBuddyIDE` — NOT the CLI's
 *  `CLI/2.168.0 CodeBuddy/2.168.0` / `X-IDE-Type: CLI`, which is what makes
 *  the account read as a CLI client upstream (the bug this fixes).
 *
 *  Pick one with the mount-row `client: 'ide' | 'vscode' | 'cli'` (default
 *  `ide`) or CODEBUDDY_CLIENT. `vscode` keeps the /v3/config catalog identity
 *  and `cli` reproduces the pre-0.10 behaviour (CLI quota channel). */
export const DEFAULTS = {
  ...EDITIONS.cn,
  client: 'ide',
  // Official IDE build (resources/app/product.json: genieVersion).
  genieVersion: '4.12.2',
  // CodeBuddy VS Code extension build / the VS Code release it runs on.
  appVersion: '4.10.35413651',
  vscodeVersion: '1.133.0',
  // CodeBuddy CLI build.
  cliVersion: '2.168.0',
  envId: 'production',
  product: 'SaaS',
};

export const CLIENT_PROFILES = {
  ide: {
    id: 'ide',
    label: 'CodeBuddy IDE',
    platform: 'CodeBuddyIDE',
    ideType: 'CodeBuddyIDE',
    ideName: 'CodeBuddyIDE',
    productName: 'CodeBuddy',
    version: DEFAULTS.genieVersion,
    productVersion: DEFAULTS.genieVersion,
    authPlatform: 'ide',
    sendsProductVersion: true,
    sendsAgentRuntime: false,
    sendsEnvId: false,
    sendsTraceId: true,
  },
  vscode: {
    id: 'vscode',
    label: 'CodeBuddy VS Code extension',
    platform: 'VSCode',
    ideType: 'VSCode',
    ideName: 'VSCode',
    productName: 'CodeBuddy',
    version: DEFAULTS.vscodeVersion,
    productVersion: DEFAULTS.appVersion,
    authPlatform: 'VSCode',
    sendsProductVersion: true,
    sendsAgentRuntime: false,
    sendsEnvId: DEFAULTS.envId,
    sendsTraceId: false,
  },
  cli: {
    id: 'cli',
    label: 'CodeBuddy CLI',
    platform: 'CLI',
    ideType: 'CLI',
    ideName: 'CLI',
    productName: 'CodeBuddy',
    version: DEFAULTS.cliVersion,
    productVersion: DEFAULTS.cliVersion,
    authPlatform: 'CLI',
    sendsProductVersion: false,
    sendsAgentRuntime: true,
    sendsEnvId: false,
    sendsTraceId: false,
  },
};

/** Coerce a user-supplied client name into a profile id ('ide' when unknown). */
export function resolveClientId(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'vscode' || v === 'vs' || v === 'extension' || v === 'ext') return 'vscode';
  if (v === 'cli' || v === 'codebuddy-cli') return 'cli';
  if (v === 'ide' || v === 'desktop' || v === 'codebuddyide' || v === 'codebuddy') return 'ide';
  return DEFAULTS.client;
}

/** The profile a cfg carries (falls back to the default identity). */
export function clientProfileOf(cfg) {
  if (cfg && cfg.profile && cfg.profile.id) return cfg.profile;
  return CLIENT_PROFILES[resolveClientId(cfg && cfg.client)];
}

/** DEFAULTS with one edition's endpoints and one client profile swapped in. */
export function cfgForEdition(editionKey = 'cn', clientKey) {
  const base = editionKey === 'intl' ? { ...DEFAULTS, ...EDITIONS.intl } : { ...DEFAULTS };
  const client = resolveClientId(clientKey === undefined || clientKey === null || clientKey === ''
    ? base.client
    : clientKey);
  return { ...base, client, profile: CLIENT_PROFILES[client] };
}

const NO_AUTH_HEADERS = {
  Accept: 'application/json',
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function resolveTenantId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  if (!p) return '';
  const m = (p.iss || '').match(/realms\/sso-([^/]+)$/);
  return p.tenant_id || p.tenantId || (m ? m[1] : '') || '';
}

export function resolveEnterpriseId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  if (!p) return '';
  const roles = (p.realm_access && p.realm_access.roles) ||
    (p.resource_access && p.resource_access.account && p.resource_access.account.roles);
  if (roles) {
    for (const r of roles) {
      const m = r.match(/group-admin:([A-Za-z0-9-]+)/);
      if (m && m[1]) return m[1];
    }
  }
  return p.enterprise_id || p.enterpriseId || p.ent_id || p.entId || '';
}

export function resolveUserId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  return (p && (p.user_id || p.userId || p.uid || p.sub)) || '';
}

export function tokenExpiresAt(accessToken) {
  const p = decodeJwtPayload(accessToken);
  return p && typeof p.exp === 'number' ? p.exp * 1000 : undefined;
}

/** POST /v2/plugin/auth/state — begin the browser OAuth dance.
 *
 *  `platform` here is the value upstream *registers* for the credential, so it
 *  must match the client the plugin will actually talk as: `ide` for the
 *  desktop IDE profile (official value), `CLI` for the CLI profile. Sending the
 *  CLI value while chatting as the IDE is exactly what left accounts marked as
 *  CLI upstream. */
export async function requestAuthState(cfg = DEFAULTS) {
  const profile = clientProfileOf(cfg);
  const params = new URLSearchParams({ platform: profile.authPlatform, ioa: '1' });
  const response = await fetch(`${cfg.serverUrl}/v2/plugin/auth/state?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NO_AUTH_HEADERS },
  });
  if (!response.ok) throw new Error(`auth state request failed: ${response.status}`);
  const data = await response.json();
  if (data.code !== 0 || !data.data || !data.data.state) {
    throw new Error(`invalid auth state response: ${JSON.stringify(data)}`);
  }
  const url = data.data.authUrl ||
    `${cfg.serverUrl}/login?platform=${profile.authPlatform}&state=${data.data.state}&ioa=1`;
  return { state: data.data.state, url, platform: profile.authPlatform, client: profile.id };
}

/** GET /v2/plugin/auth/token — one poll attempt; null while still pending. */
export async function pollTokenOnce(state, cfg = DEFAULTS) {
  const response = await fetch(`${cfg.serverUrl}/v2/plugin/auth/token?state=${state}`, {
    headers: NO_AUTH_HEADERS,
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (data.code === 0 && data.data && data.data.accessToken) return data.data;
  return null;
}

/** Poll until the token lands or the flow expires. */
export async function pollForToken(state, { timeoutMs = 10 * 60 * 1000, intervalMs = 3000, onTick, cfg = DEFAULTS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    attempt += 1;
    if (onTick) onTick(attempt);
    try {
      const hit = await pollTokenOnce(state, cfg);
      if (hit) return hit;
    } catch {
      // transient network error — keep polling
    }
  }
  return null;
}

/** POST /v2/plugin/auth/token/refresh. The refresh token is sent BOTH as the
 *  `X-Refresh-Token` header (the spelling the official CLI and sibling plugins
 *  use, verified live) and as `Authorization: Bearer` (the shape this plugin
 *  shipped with pre-0.9), so a server that accepts either keeps working. */
export async function refreshAccessToken(refreshToken, cfg = DEFAULTS) {
  try {
    const response = await fetch(`${cfg.serverUrl}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${refreshToken}`,
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        ...clientIdentityHeaders(cfg),
      },
      body: '{}',
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.code !== 0) return null;
    return data.data || null;
  } catch {
    return null;
  }
}

/** Identity headers derivable from the JWT (stable for one account). */
export function identityHeaders(accessToken) {
  const headers = {};
  const tenantId = resolveTenantId(accessToken);
  const enterpriseId = resolveEnterpriseId(accessToken);
  const userId = resolveUserId(accessToken);
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId;
  if (userId) headers['X-User-Id'] = userId;
  return headers;
}

/** The client-identity header set for one profile.
 *
 *  Every header here is one the official client of that profile really sends
 *  (see CLIENT_PROFILES for the evidence), and the set is shared by chat,
 *  account, billing and refresh calls so a single account never contradicts
 *  itself across planes:
 *
 *   - `User-Agent`      `${platform}/${version} ${productName}/${productVersion}`
 *   - `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version`
 *   - `X-Product`       deployment type ("SaaS")
 *   - `X-Agent-Intent`  "craft" on every official model/account call
 *   - `x-requested-with` (both official clients' HTTP layer sends it)
 *
 *  Profile-gated, never invented:
 *   - `X-Product-Version` — IDE + VS Code extension only (the CLI declares the
 *     constant but never sets it).
 *   - `X-Env-ID` — VS Code extension only.
 *   - `X-Agent-Runtime` — CLI only ("other" when no runtime baggage is set).
 *   - `X-Request-Trace-Id` — IDE only (CustomHeadersHttpProxyInterceptor).
 *
 *  Deliberately absent from every profile: `x-codebuddy-request`. In the CLI it
 *  is only a local gateway / daemon / ACP marker; verified live without it
 *  (chat 200 + SSE, /v2/plugin/account code 0, get-user-resource code 0). */
export function clientWireHeaders(profile, { domain, product = DEFAULTS.product, accessToken } = {}) {
  const p = profile && profile.platform ? profile : CLIENT_PROFILES[DEFAULTS.client];
  const version = p.version || '';
  const headers = {
    'User-Agent': `${p.platform}/${version} ${p.productName}/${p.productVersion || version}`,
    'X-Product': product,
    'X-IDE-Type': p.ideType,
    'X-IDE-Name': p.ideName,
    'X-IDE-Version': version,
    'X-Agent-Intent': 'craft',
    'X-Domain': domain,
    'x-requested-with': 'XMLHttpRequest',
  };
  if (p.sendsProductVersion) headers['X-Product-Version'] = p.productVersion;
  if (p.sendsEnvId) headers['X-Env-ID'] = p.sendsEnvId;
  if (p.sendsAgentRuntime) headers['X-Agent-Runtime'] = 'other';
  if (p.sendsTraceId) headers['X-Request-Trace-Id'] = randomUUID();
  if (accessToken) Object.assign(headers, identityHeaders(accessToken));
  return headers;
}

/** Profile-aware convenience wrapper for cfg-shaped callers. */
export function clientIdentityHeaders(cfg, accessToken) {
  return clientWireHeaders(clientProfileOf(cfg), {
    domain: cfg.domain,
    product: cfg.product,
    accessToken,
  });
}

/** GET /v3/config — model discovery.
 *
 *  This one call keeps the VS Code extension identity
 *  (`VSCode/<vscodeVersion> CodeBuddy/<appVersion>`): the catalog is switched by
 *  the UA brand token alone, and `VSCode/...` is the one that answers with the
 *  craft catalog (discloses supportedEfforts / canDisableThinking /
 *  defaultEffort and the curated model list), while the CLI token answers with
 *  the `cli` agent only. Verified live: the switch is the UA brand token, not
 *  X-IDE-*. It is a discovery call — no credential attribution rides on it —
 *  so it is safe to keep on the extension identity regardless of which client
 *  profile chat uses. */
export async function fetchRemoteModels(accessToken, cfg = DEFAULTS) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...clientWireHeaders(CLIENT_PROFILES.vscode, {
      domain: cfg.domain,
      product: cfg.product,
      accessToken,
    }),
  };
  const resp = await fetch(`${cfg.serverUrl}/v3/config`, { headers });
  if (!resp.ok) throw new Error(`/v3/config answered ${resp.status}`);
  const body = await resp.json();
  if (body.code !== 0 || !body.data) throw new Error(`/v3/config replied code ${body.code}`);
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craft = (body.data.agents || []).find((a) => a.name === 'craft');
  const ids = (craft && craft.models) || [];
  return ids
    .map((id) => modelMap.get(id))
    .filter((m) => m && m.supportsToolCall);
}

/** GET /v2/plugin/account — account identity for display. Sent with the same
 *  client profile the chat/billing calls use (so one account never reports two
 *  different clients) plus the bearer token. Returns a lossless subset; never
 *  throws — a failed lookup degrades to whatever the JWT already knows. */
export async function fetchAccountInfo(accessToken, cfg = DEFAULTS) {
  try {
    const response = await fetch(`${cfg.serverUrl}/v2/plugin/account`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...clientIdentityHeaders(cfg, accessToken) },
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body.code !== 0 || !body.data) return null;
    const d = body.data;
    return {
      uid: d.uid || '',
      nickname: d.nickname || '',
      uin: d.uin || '',
      phone: d.phoneNumber || '',
      accountType: d.accountType || d.type || '',
      pluginEnabled: d.pluginEnabled === true,
    };
  } catch {
    return null;
  }
}

// Parse CodeBuddy's "YYYY-MM-DD HH:MM:SS" timestamps, which the service writes
// in Beijing time (UTC+8). Returns NaN (treated as "unknown / assume active")
// when the string is absent or unparseable.
function parseBeijing(value) {
  if (!value || typeof value !== 'string') return NaN;
  const instant = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  return Number.isNaN(instant) ? Date.parse(value) : instant;
}

function num(...candidates) {
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return 0;
}

/** POST /v2/billing/meter/get-user-resource — the credit balance.
 *
 *  VERIFIED live shape:
 *    { code:0, data:{ Response:{ Data:{ TotalCount, TotalDosage,
 *        Accounts:[ { CapacityUnit:"credits", CapacityRemain, CapacitySize,
 *          CapacityUsed, CycleCapacityRemain, ..., ExpiredTime:"...", Status }
 *        ] } } } }
 *
 *  Aggregation (the exact Status-code semantics are Tencent-internal and not
 *  publicly documented — ⚠️ treated conservatively): sum the remaining/used/size
 *  of every `credits`-unit package whose ExpiredTime is not in the past, so an
 *  exhausted or lapsed grant never inflates the balance. Returns null on any
 *  transport/shape failure rather than throwing, so a quota hiccup never breaks
 *  login or a chat turn. */
export async function fetchQuota(accessToken, cfg = DEFAULTS) {
  try {
    const response = await fetch(`${cfg.serverUrl}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...clientIdentityHeaders(cfg, accessToken) },
      body: '{}',
    });
    if (!response.ok) return null;
    const body = await response.json();
    const accounts = body && body.data && body.data.Response && body.data.Response.Data && body.data.Response.Data.Accounts;
    if (!Array.isArray(accounts)) return null;
    const now = Date.now();
    let remaining = 0;
    let used = 0;
    let total = 0;
    let activePackages = 0;
    const packages = [];
    for (const pkg of accounts) {
      if (String(pkg.CapacityUnit || pkg.OriginUnit || 'credits').toLowerCase() !== 'credits') continue;
      const expiry = parseBeijing(pkg.ExpiredTime);
      const expired = !Number.isNaN(expiry) && expiry <= now;
      const remain = num(pkg.CapacityRemainPrecise, pkg.CapacityRemain);
      if (!expired) {
        remaining += Math.max(0, remain);
        used += Math.max(0, num(pkg.CapacityUsedPrecise, pkg.CapacityUsed));
        total += Math.max(0, num(pkg.CapacitySizePrecise, pkg.CapacitySize));
        if (remain > 0) activePackages += 1;
      }
      packages.push({
        name: pkg.PackageName || pkg.SubProductName || pkg.ResourceId || '',
        remaining: Math.max(0, remain),
        size: Math.max(0, num(pkg.CapacitySizePrecise, pkg.CapacitySize)),
        expired,
        expiresAt: Number.isNaN(expiry) ? undefined : expiry,
      });
    }
    packages.sort((a, b) => (b.remaining - a.remaining) || (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
    return {
      remaining,
      used,
      total,
      activePackages,
      // exhausted == no credit left across all non-expired packages; the pool
      // uses it to decide when to rotate to the next account.
      exhausted: remaining <= 0,
      checkedAt: now,
      packages: packages.slice(0, 12),
    };
  } catch {
    return null;
  }
}
