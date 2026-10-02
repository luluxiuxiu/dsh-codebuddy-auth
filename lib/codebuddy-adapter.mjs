/**
 * Native ctx.llm adapter for CodeBuddy. Ported from shatyuka/dsh-llm-codebuddy
 * (MIT). Owns the chat wire: CLI identity headers, SSE streaming, and message
 * serialization — the pieces the shared pi-ai route could not control.
 * Plain ESM, no dependencies, Node >= 18.
 */

import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  ReasoningEffortId,
  ProviderRequestId,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  textOnlyImageText,
  QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isQuotaExceededError,
  isContextWindowExceededError,
  EMPTY_RESPONSE_CODE,
} from '@deepseek-ai/dsh-llm';

export const SSE_DONE = '[DONE]';
const CATALOG_TTL_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * SSE framing (no eventsource-parser): reassemble chunks, join multi-
 * `data:` lines, stop at [DONE], throw STREAM_CLOSED on truncation.
 * ------------------------------------------------------------------ */

export async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (rawLine.length === 0 || rawLine.startsWith(':')) {
          // event boundary or comment: flush collected data lines
          if (dataLines.length > 0) {
            const payload = dataLines.join('\n');
            dataLines = [];
            yield payload;
            if (payload === SSE_DONE) return;
          }
        } else if (rawLine.startsWith('data:')) {
          dataLines.push(rawLine.slice(5).replace(/^ /, ''));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (dataLines.length > 0 && dataLines.join('\n') === SSE_DONE) return;
  throw new LlmError('CodeBuddy SSE stream ended without [DONE]', 'STREAM_CLOSED');
}

/* ------------------------------------------------------------------ *
 * Image input: durable attachment references → inline image parts.
 *
 * Every CodeBuddy craft model advertises `supportsImages`, and the chat
 * plane parses OpenAI's `image_url` part carrying a data URL (verified
 * live against /v2/chat/completions), so one occurrence goes on the wire
 * as `{type:'image_url', image_url:{url:'data:<mediaType>;base64,...'}}`
 * beside the harness's own per-image text handle.
 * ------------------------------------------------------------------ */

/** Per-occurrence request budget: the store's normalized dimensions are kept
 *  as-is and the encoder is asked for at most 1 MiB, because a durable
 *  occurrence is re-encoded into every later request of the session. Mirrors
 *  the default image policy of the dsh-llm-pi-ai adapter. */
const IMAGE_REQUEST_MAX_PIXELS = 2048 * 2048;
const IMAGE_REQUEST_MAX_BYTES = 1024 * 1024;

/** Aspect-preserving integer dimensions within a total-pixel budget, with
 *  small images never enlarged: the geometry `requestImageDimensions` applies
 *  inside @deepseek-ai/dsh-attachment, kept local so this plugin needs no
 *  extra package import. Undefined when the reference withholds its intrinsic
 *  dimensions, which leaves the raw normalized read as the only option. */
function requestImageTarget(ref) {
  const width = Number(ref.width);
  const height = Number(ref.height);
  if (!(width > 0) || !(height > 0)) return undefined;
  const scale = Math.min(1, Math.sqrt(IMAGE_REQUEST_MAX_PIXELS / (width * height)));
  return {
    width: scale === 1 ? width : Math.max(1, Math.floor(width * scale)),
    height: scale === 1 ? height : Math.max(1, Math.floor(height * scale)),
    maxBytes: IMAGE_REQUEST_MAX_BYTES,
  };
}

/** Read one occurrence's model-request version. `readImageRequest` re-encodes
 *  the stored image for this route (the 0.2.0 store contract); the raw
 *  normalized read is the older one. */
async function readRequestImage(attachments, ref, signal) {
  const target = requestImageTarget(ref);
  if (target !== undefined && typeof attachments.readImageRequest === 'function') {
    return attachments.readImageRequest(ref, target, signal);
  }
  if (typeof attachments.readImage !== 'function') {
    throw new LlmError('The mounted attachment provider cannot read images for a model request.', 'UNSUPPORTED_CONTENT');
  }
  const stored = await attachments.readImage(ref, signal);
  return { ...stored.ref, data: stored.data, mediaType: stored.ref.mediaType };
}

/** True when any block carries an image, the folded 0.1.6 `tool-result` shape
 *  included. */
function hasImage(blocks) {
  return (blocks || []).some((block) => block.type === 'image'
    || (block.type === 'tool-result' && hasImage(block.content)));
}

/** Collect the retained occurrences of one content list, keyed by attachment
 *  id: compaction's `offloaded` mark means the occurrence must not be re-sent,
 *  so it is left to the harness's placeholder projection. */
function collectImageRefs(blocks, into) {
  for (const block of blocks || []) {
    if (block.type === 'image') {
      if (block.offloaded !== true) into.set(block.attachment.attachmentId, block.attachment);
    } else if (block.type === 'tool-result') {
      collectImageRefs(block.content, into);
    }
  }
}

/** One inline image part in the shape the chat plane parses. */
function imagePart(version) {
  const base64 = Buffer.from(version.data).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${base64}` } };
}

/** Model-facing text for one occurrence: the harness's request-image handle
 *  when its bytes ride the wire, its text-only substitution when the model
 *  takes no image, and its omission text when the occurrence was not read. */
function imageNoteText(block, images) {
  const ref = block.attachment;
  if (!images.supportsImages) return textOnlyImageText(ref);
  const version = images.versions.get(ref.attachmentId);
  if (version === undefined) return offloadedImageText(ref, images.access(ref));
  return requestImageHandleText(ref, version, images.access(ref));
}

/* ------------------------------------------------------------------ *
 * Request serialization: harness messages → OpenAI-compatible wire.
 * ------------------------------------------------------------------ */

function textOf(blocks) {
  return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** Text plus the notes of any image this role's wire shape cannot carry (the
 *  system and assistant turns): an occurrence is never dropped silently. */
function textWithImageNotes(blocks, images) {
  const text = textOf(blocks);
  if (images === undefined) return text;
  const notes = (blocks || []).filter((b) => b.type === 'image').map((b) => imageNoteText(b, images));
  return notes.length === 0 ? text : `${text}${text.length > 0 ? '\n' : ''}${notes.join('\n')}`;
}

function serializeAssistant(message, images) {
  const content = message.content || [];
  const toolCalls = content
    .filter((b) => b.type === 'tool-call')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
  const reasoning = content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
  return {
    role: 'assistant',
    // content is always a string, never null: a reasoning-only or tool-call
    // turn sits in the durable log, and null content breaks later turns.
    content: textWithImageNotes(content, images),
    // reasoning is replayed only on tool-call turns (thinking-mode passback).
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/** One tool result's model-visible text; a missing/empty body keeps the wire
 *  turn well-formed (OpenAI rejects an empty tool message content). A tool
 *  image stays text: the `tool` role of this wire carries text only, so the
 *  occurrence reaches the model as its handle — which names the normalized
 *  copy a file-reading tool can open — instead of being dropped. */
function toolResultBody(content, isError, images) {
  const body = textOf(content) || (isError ? '(tool errored with no output)' : '(no output)');
  if (images === undefined) return body;
  const notes = (content || []).filter((b) => b.type === 'image').map((b) => imageNoteText(b, images));
  return notes.length === 0 ? body : `${body}\n\n${notes.join('\n')}`;
}

/** One user turn's model-visible content: the plain string this wire has
 *  always carried when no image rides it, otherwise OpenAI's content parts
 *  (text, request-image handle text, inline image). */
function userContent(blocks, images) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type !== 'image') continue;
    const ref = block.attachment;
    if (!images.supportsImages) {
      parts.push({ type: 'text', text: textOnlyImageText(ref) });
      continue;
    }
    const version = images.versions.get(ref.attachmentId);
    if (version === undefined) {
      parts.push({ type: 'text', text: offloadedImageText(ref, images.access(ref)) });
      continue;
    }
    parts.push({ type: 'text', text: requestImageHandleText(ref, version, images.access(ref)) });
    parts.push(imagePart(version));
  }
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('');
  return parts;
}

/** Tool results reach the adapter in two shapes depending on the harness's
 *  DSH version, and both must fold back into the provider's `role: 'tool'`
 *  wire message or the loop silently drops the tool output:
 *  - 0.1.7+: first-class `role: 'tool'` messages (each carries `toolCallId` +
 *    `isError`);
 *  - 0.1.6 and the shipped desktop runtime: `tool-result` blocks folded into a
 *    `role: 'user'` message (each block carries `toolCallId` + `content` +
 *    `isError`).
 *  `role: 'developer'` records mid-conversation tool add/remove, which we
 *  ignore because serializeRequest always re-declares the full tool list.
 * @param messages - harness history, already projected (offloaded images
 *   replaced by their placeholder text).
 * @param images - `undefined` when the history carries no image at all (the
 *   wire stays exactly what a text-only session sent); otherwise the resolved
 *   image plan `{supportsImages, versions, access}`. */
export function serializeMessages(messages, images) {
  const wire = [];
  for (const message of messages) {
    const content = message.content || [];
    if (message.role === 'system') {
      wire.push({ role: 'system', content: textWithImageNotes(content, images) });
      continue;
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message, images));
      continue;
    }
    if (message.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: toolResultBody(content, message.isError, images) });
      continue;
    }
    // developer messages carry no model-visible text for this wire shape.
    if (message.role === 'developer') continue;
    // user (and any other role): split folded `tool-result` blocks (0.1.6
    // shape) out ahead of the plain text so each becomes its own tool turn.
    for (const block of content) {
      if (block.type === 'tool-result') {
        wire.push({ role: 'tool', tool_call_id: block.toolCallId, content: toolResultBody(block.content, block.isError, images) });
      }
    }
    const remainder = content.filter((block) => block.type !== 'tool-result');
    if (remainder.length === 0) continue;
    const userWireContent = images === undefined ? textOf(remainder) : userContent(remainder, images);
    if (userWireContent.length > 0) wire.push({ role: 'user', content: userWireContent });
  }
  return wire;
}

export function serializeRequest(options, images) {
  const messages = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  messages.push(...serializeMessages(options.messages || [], images));
  const tools = options.tools && options.tools.length > 0
    ? options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined;
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  };
}

/* ------------------------------------------------------------------ *
 * Response translation: SSE payloads → harness StreamChunk protocol.
 * ------------------------------------------------------------------ */

const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** A property schema with no `type` accepts any JSON value. */
function acceptsAnyJsonValue(schema) {
  if (schema === true) return true;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  return !('type' in schema) && !('$ref' in schema) && !('const' in schema) && !('enum' in schema)
    && !('allOf' in schema) && !('anyOf' in schema) && !('oneOf' in schema) && !('not' in schema);
}

function decodeNestedComposite(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  const composite = (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
  if (!composite) return value;
  try {
    const decoded = JSON.parse(t);
    return decoded !== null && typeof decoded === 'object' ? decoded : value;
  } catch {
    return value;
  }
}

/** CodeBuddy sometimes double-encodes object/array values of unconstrained
 *  tool fields as JSON strings; decode exactly that shape. */
function normalizeToolArguments(name, argumentsText, tools) {
  const tool = (tools || []).find((t) => t.name === name);
  const properties = tool && tool.parameters ? tool.parameters.properties : undefined;
  if (properties === undefined) return argumentsText;
  let args;
  try {
    args = JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return argumentsText;
  let changed = false;
  for (const [key, schema] of Object.entries(properties)) {
    if (!acceptsAnyJsonValue(schema) || !(key in args)) continue;
    const decoded = decodeNestedComposite(args[key]);
    if (decoded !== args[key]) { args[key] = decoded; changed = true; }
  }
  return changed ? JSON.stringify(args) : argumentsText;
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

function mapUsage(usage) {
  const cacheRead = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens;
  const prompt = usage.prompt_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - (cacheRead ?? 0)),
    outputTokens: usage.completion_tokens ?? 0,
    ...(Number.isFinite(usage.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function closeBlock(block, tools) {
  if (block.kind === 'text') return { type: 'text', text: block.text };
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text };
  return {
    type: 'tool-call',
    id: ToolCallId(block.callId ?? ''),
    name: block.name ?? '',
    arguments: normalizeToolArguments(block.name ?? '', block.text, tools),
  };
}

/** Deltas stream as they arrive; block ends, usage, and finish flush at
 *  [DONE] — usage strictly before finish, nothing after finish. */
export async function* translate(payloads, tools = []) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  const open = (kind) => { const b = { index: nextIndex++, kind, text: '' }; order.push(b); return b; };

  for await (const payload of payloads) {
    if (payload === SSE_DONE) {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block, tools) };
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage };
      const reason = pendingFinish ?? { kind: 'stop' };
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      };
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed CodeBuddy SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      // reasoning first: thinking models interleave it ahead of text; accept
      // both field spellings; an empty first delta opens nothing.
      const reasoning = (delta && (delta.reasoning_content ?? delta.reasoning)) || undefined;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += reasoning;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
      }
      const content = delta && delta.content;
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += content;
        yield { type: 'text-delta', index: textBlock.index, text: content };
      }
      for (const call of (delta && delta.tool_calls) || []) {
        let block = toolBlocks.get(call.index);
        if (block === undefined) {
          block = open('tool-call');
          toolBlocks.set(call.index, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        // only the opening delta carries id/name; later frames repeat "".
        if (call.id !== undefined && call.id.length > 0) block.callId = call.id;
        const name = call.function && call.function.name;
        if (name !== undefined && name.length > 0) block.name = name;
        const fragment = (call.function && call.function.arguments) || '';
        block.text += fragment;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        };
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason);
    }
    // `usage: null` rides every non-final chunk — null-tolerant test.
    if (chunk.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage);
  }

  throw new LlmError('CodeBuddy SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
}

/* ------------------------------------------------------------------ *
 * HTTP status mapping + the adapter.
 * ------------------------------------------------------------------ */

function providerRetryAfterMs(value) {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers) {
  const value = headers.get('x-request-id') ?? headers.get('x-requestid');
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

export function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return 'AUTH';
  const detail = [error && error.code, error && error.type, error && error.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

/** Whether CodeBuddy advertises image input for one catalog entry.
 *  `disabledMultimodal` is the catalog's own per-entry kill switch, verified
 *  in the live /v3/config payload. */
function modelAcceptsImages(model) {
  return model.supportsImages === true && model.disabledMultimodal !== true;
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name || model.id,
    inputModalities: modelAcceptsImages(model) ? ['text', 'image'] : ['text'],
  };
}

/** Disclosed thinking levels → harness reasoning metadata; undefined when the
 *  catalog offers nothing selectable (a rejected catalog is worse than an
 *  absent capability). Ids pass through: they are the wire `reasoning_effort`
 *  spellings. */
function reasoningInfo(model) {
  const supported = model.reasoning && model.reasoning.supportedEfforts;
  if (!Array.isArray(supported)) return undefined;
  const seen = new Set();
  const efforts = [];
  for (const raw of supported) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    efforts.push({ id: ReasoningEffortId(id), name: EFFORT_NAMES[id] ?? id });
  }
  if (efforts.length === 0) return undefined;
  const candidate = model.reasoning && (model.reasoning.defaultEffort ?? model.reasoning.effort);
  const defaultEffort = candidate !== undefined && seen.has(candidate)
    ? ReasoningEffortId(candidate)
    : undefined;
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

/**
 * One adapter serves the `codebuddy` route.
 * @param {object} deps
 * @param {() => Promise<string|undefined>} deps.getAccessToken
 * @param {() => {chatBaseURL: string, domain: string, cliVersion: string, product?: string}} deps.connection
 * @param {() => Promise<readonly object[]>} deps.readCatalog — tool-call-capable
 *   /v3/config entries; throws when logged out.
 * @param {(token: string) => Record<string, string>} [deps.identityFromToken]
 * @param {(code: string) => void} [deps.onGatewayError] — fired with
 *   QUOTA_EXCEEDED_CODE / RATE_LIMIT before the error is thrown, so the account
 *   pool can rotate off the exhausted or throttled account.
 * @param {() => object|undefined} [deps.resolveAttachments] — the harness's
 *   durable attachment store (`ctx.attachments`), needed only to carry images.
 * @param {(ref: object) => (object|undefined)} [deps.resolveImageAccess] —
 *   resolves one occurrence's normalized copy for the tool world, decorating
 *   the per-image text handle; optional and advisory.
 * @param {object} [deps.defaults] — fallback capacities for unlisted ids.
 */
export class CodebuddyAdapter extends LlmAdapter {
  constructor({ getAccessToken, connection, readCatalog, identityFromToken, onGatewayError, resolveAttachments, resolveImageAccess, defaults = {} }) {
    super();
    this.getAccessToken = getAccessToken;
    this.connection = connection;
    this.readCatalog = readCatalog;
    this.identityFromToken = identityFromToken;
    this.onGatewayError = onGatewayError;
    this.resolveAttachments = resolveAttachments;
    this.resolveImageAccess = resolveImageAccess;
    this.defaults = { contextWindow: defaults.contextWindow ?? 128000, maxTokens: defaults.maxTokens ?? 8192 };
    this.catalog = undefined;
    this.catalogRead = undefined;
  }

  providerInfo(provider) {
    return { id: provider, name: 'CodeBuddy' };
  }

  /**
   * Resolve every retained image occurrence of one request into wire-ready
   * versions. Returns `undefined` when the history carries no image at all, so
   * a text session keeps the exact wire it had before images were handled
   * here.
   *
   * Compaction marks an occurrence `offloaded` when a later request must not
   * carry it again; the harness's own projection replaces those with their
   * deterministic placeholder text first, and only the remaining occurrences
   * are read from the attachment store. When the catalog says the target model
   * takes no image, nothing is read: every occurrence becomes the harness's
   * text-only substitution, which is also what the runtime itself applies to a
   * route declared text-only (so a capability disagreeing with the declaration
   * degrades the same way instead of failing the turn).
   * @param {object} options - harness request options.
   * @param {boolean} acceptsImages - catalog answer for the target model.
   * @returns {Promise<{messages: readonly object[], images: object}|undefined>}
   */
  async imageProjection(options, acceptsImages) {
    const messages = options.messages || [];
    if (!messages.some((message) => hasImage(message.content))) return undefined;
    // Path resolution is advisory: a failure costs the text handle a hint,
    // never the request.
    const access = (ref) => {
      try {
        return this.resolveImageAccess ? this.resolveImageAccess(ref) : undefined;
      } catch {
        return undefined;
      }
    };
    const projected = projectOffloadedImages(messages, (ref) => offloadedImageText(ref, access(ref)));
    const images = { supportsImages: acceptsImages, versions: new Map(), access };
    if (!acceptsImages) return { messages: projected, images };

    const attachments = this.resolveAttachments ? this.resolveAttachments() : undefined;
    if (attachments === undefined) {
      throw new LlmError(
        'CodeBuddy image input needs the durable attachment service (ctx.attachments), which this harness mount does not provide.',
        'UNSUPPORTED_CONTENT',
      );
    }
    const refs = new Map();
    for (const message of projected) collectImageRefs(message.content, refs);
    try {
      const ids = [...refs.keys()];
      const versions = await Promise.all(ids.map((id) => readRequestImage(attachments, refs.get(id), options.signal)));
      ids.forEach((id, index) => images.versions.set(id, versions[index]));
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(`CodeBuddy could not read a stored image for this request: ${error && error.message}`, 'UNSUPPORTED_CONTENT', { cause: error });
    }
    return { messages: projected, images };
  }

  /** Cached catalog, shared between concurrent readers. */
  async models(signal) {
    if (this.catalog && Date.now() - this.catalog.readAt < CATALOG_TTL_MS) return this.catalog.models;
    this.catalogRead ??= (async () => {
      try {
        const models = await this.readCatalog(signal);
        this.catalog = { readAt: Date.now(), models };
      } finally {
        this.catalogRead = undefined;
      }
    })();
    return this.catalogRead.then(() => (this.catalog ? this.catalog.models : []));
  }

  refreshCatalog() {
    this.catalog = undefined;
  }

  async listModels(provider) {
    let models;
    try {
      models = await this.models();
    } catch {
      return []; // logged out or unreachable: offer nothing rather than fail
    }
    // drop entries whose capacity the catalog withholds; they stay routable.
    return models
      .filter((m) => m.maxInputTokens !== undefined && m.maxInputTokens > 0)
      .map((m) => modelInfo(provider, m));
  }

  async resolveModel(provider, model, signal) {
    let entry;
    try {
      entry = (await this.models(signal)).find((m) => m.id === model);
    } catch {
      entry = undefined;
    }
    if (entry === undefined) {
      // unlisted id is still routable — declare a conservative text-only shape.
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: this.defaults.contextWindow },
        defaultMaxTokens: this.defaults.maxTokens,
      };
    }
    const reasoning = reasoningInfo(entry);
    return {
      ...modelInfo(provider, entry),
      context: { contextWindow: entry.maxInputTokens > 0 ? entry.maxInputTokens : this.defaults.contextWindow },
      defaultMaxTokens: entry.maxOutputTokens > 0 ? entry.maxOutputTokens : this.defaults.maxTokens,
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  async *stream(options) {
    // Resolve the token first: the active account (and thus its edition/
    // endpoint) is chosen during getAccessToken, so connection() must run after
    // it to describe the same account the bearer came from.
    const token = await this.getAccessToken();
    const connection = this.connection();
    if (token === undefined) {
      throw new LlmError('CodeBuddy is not logged in — tell the agent "log in with codebuddy", then retry.', 'MISSING_CREDENTIAL');
    }

    const identity = this.identityFromToken ? this.identityFromToken(token) : {};
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      // the CLI identity the chat plane expects — the attribute the shared
      // pi-ai route cannot set (its User-Agent is attribution-reserved). The
      // x-codebuddy-request marker + IDE/product headers match what the real
      // CLI sends and what the billing/chat gateways attribute on.
      'User-Agent': `CLI/${connection.cliVersion} CodeBuddy/${connection.cliVersion}`,
      'X-Domain': connection.domain,
      'X-Product': connection.product || 'SaaS',
      'X-IDE-Type': 'CLI',
      'X-IDE-Name': 'CLI',
      'x-requested-with': 'XMLHttpRequest',
      'x-codebuddy-request': '1',
      ...identity,
    };

    const models = await this.models().catch(() => []);
    const entry = models.find((m) => m.id === options.model);
    const acceptsImages = entry !== undefined && modelAcceptsImages(entry);
    if ((options.tools ?? []).length > 0 && entry && entry.supportsToolCall === false) {
      throw new LlmError(`CodeBuddy model "${options.model}" does not support tool calls`, 'UNSUPPORTED_OPTION');
    }

    const projection = await this.imageProjection(options, acceptsImages);
    const payload = JSON.stringify(serializeRequest(
      projection === undefined ? options : { ...options, messages: projection.messages },
      projection === undefined ? undefined : projection.images,
    ));
    let response;
    try {
      response = await fetch(`${connection.chatBaseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal && options.signal.aborted) {
        throw new LlmError('CodeBuddy request aborted by caller', 'ABORTED', { cause: error });
      }
      throw new LlmError(`CodeBuddy request to ${connection.chatBaseURL} failed`, 'TRANSPORT', { cause: error });
    }

    if (!response.ok) {
      let message = `CodeBuddy API error (HTTP ${response.status})`;
      let providerError;
      try {
        const parsed = await response.json();
        providerError = parsed.error;
        if (providerError && providerError.message) message = providerError.message;
      } catch {
        // malformed error body: status still identifies the failure
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      const id = requestId(response.headers);
      const code = httpErrorCode(response.status, providerError);
      // Account-level signals (out of credit / throttled) let the pool rotate
      // off this account before we surface the failure to the loop.
      if (this.onGatewayError && (code === QUOTA_EXCEEDED_CODE || code === 'RATE_LIMIT')) {
        try { this.onGatewayError(code); } catch { /* rotation is advisory, never masks the error */ }
      }
      throw new LlmError(message, code, {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      });
    }

    if (response.body === null) throw new LlmError('CodeBuddy API returned no response body', 'EMPTY_RESPONSE');

    yield* translate(parseSse(response.body), options.tools ?? []);
  }
}
