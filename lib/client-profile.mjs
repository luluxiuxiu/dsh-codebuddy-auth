/**
 * 出站客户端身份的持久化（面板可选、运行时切换）。
 *
 * 为什么需要单独一层：身份有三个来源，优先级从低到高——
 *
 *   1. `CLIENT_PROFILES` 的默认值（`ide`）；
 *   2. 挂载行的 `client:` / 环境变量 `CODEBUDDY_CLIENT`（部署期决定）；
 *   3. 设置面板里选的这一份（运行期可改，存在 `ctx.credentials`）。
 *
 * 第 3 层必须写进 credentials 而不是内存：主插件（聊天）与 `/web` 面板是两个
 * fiber、各自持有自己的 AccountPool，只有 credentials 是共享的。写入后两侧
 * 都会在下一个请求前读到新值（见 readClientChoice 的短 TTL 缓存）。
 *
 * 注意：切换身份**不会**改写已存在凭证在上游的登记类型——那是在授权握手
 * (`?platform=`) 时定下的。面板上的提示文案会明确要求重新登录。
 */
import { resolveClientId } from './codebuddy-core.mjs';

/** credentials ref：存一个 profile id 字符串。 */
export const CLIENT_PROFILE_REF = 'CODEBUDDY_CLIENT_PROFILE';

/** 跨 fiber 的收敛延迟：同一个进程里两个 pool 最多 3 秒对齐一次。 */
const CACHE_TTL_MS = 3000;

/** credentials 对象 -> { at, value }；WeakMap 保证不拖住宿主对象。 */
const cache = new WeakMap();

function cacheable(credentials) {
  return credentials !== null && typeof credentials === 'object';
}

/**
 * 读当前生效的客户端身份。
 *
 * @param {object} credentials — ctx.credentials（`resolve`/`set` 二者至少其一）
 * @param {{ fallback?: string, maxAgeMs?: number }} [options]
 *   fallback: 未持久化时的回退值（通常是 `config.client` / 环境变量）；
 *   maxAgeMs: 缓存有效期，传 0 强制回源。
 * @returns {Promise<'ide'|'vscode'|'cli'>} 已归一化的 profile id
 */
export async function readClientChoice(credentials, { fallback, maxAgeMs = CACHE_TTL_MS } = {}) {
  const fallbackId = resolveClientId(fallback);
  if (!cacheable(credentials) || typeof credentials.resolve !== 'function') return fallbackId;

  const cached = cache.get(credentials);
  if (cached !== undefined && Date.now() - cached.at < maxAgeMs) return cached.value;

  let stored = '';
  try {
    const hit = await credentials.resolve(CLIENT_PROFILE_REF);
    stored = hit && typeof hit.value === 'string' ? hit.value : '';
  } catch {
    // 凭据服务读失败不能把身份卡死：沿用回退值，下一次再试
    return cached !== undefined ? cached.value : fallbackId;
  }
  // 空值表示「没选过」：回退值仍然生效，不回写，避免把部署配置钉死。
  const value = stored === '' ? fallbackId : resolveClientId(stored);
  if (cacheable(credentials)) cache.set(credentials, { at: Date.now(), value });
  return value;
}

/**
 * 持久化面板选择。
 *
 * 先写缓存再写凭据：即使 credentials 写失败，本次运行也已经按用户的选择走，
 * 面板不会出现「点了没反应」。写失败只影响重启后的持久性。
 *
 * @returns {Promise<string>} 归一化后的 profile id
 */
export async function saveClientChoice(credentials, value) {
  const resolved = resolveClientId(value);
  if (cacheable(credentials)) cache.set(credentials, { at: Date.now(), value: resolved });
  if (cacheable(credentials) && typeof credentials.set === 'function') {
    try {
      await credentials.set(CLIENT_PROFILE_REF, resolved);
    } catch {
      // 持久化失败不阻断切换（见上），由调用方决定是否提示
    }
  }
  return resolved;
}

/** 仅供测试/诊断：丢掉缓存，强制下次回源。 */
export function resetClientChoiceCache(credentials) {
  if (cacheable(credentials)) cache.delete(credentials);
}
