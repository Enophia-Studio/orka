import type { AssistantMessage, ChatMessage, ToolSpec, Usage } from '../types';

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /**
   * The caller retries transient failures itself (and shows the wait): the provider makes one
   * attempt instead of retrying out of sight in its SDK.
   */
  selfRetry?: boolean;
}

/** Incremental events emitted while a response streams in. */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'notice'; message: string }
  /** What the provider waits for: starting its CLI, then the model (thinking). */
  | { type: 'status'; reason: 'starting' | 'thinking' }
  /** The provider starts the turn over: what it streamed so far is replaced, not continued. */
  | { type: 'restart' };

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export interface ChatResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  /** Extra detail for refusals and unusual stops. */
  stopDetail?: string;
  usage: Usage;
  /** The model that actually served the response (can differ after a fallback). */
  model: string;
  /** The model's context window in tokens, when the provider reports it with the response. */
  contextWindow?: number;
}

/**
 * The only thing the orchestrator knows about a model vendor. Adding Gemini, OpenRouter or a
 * custom endpoint means implementing this interface - nothing else changes.
 */
export interface AIProvider {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  /** false: the model takes text only, so images are left out (with a notice); unset: it can see. */
  readonly acceptsImages?: boolean;
  chat(request: ChatRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<ChatResponse>;
  /** Release long-lived resources (e.g. local CLI processes). */
  dispose?(): void;
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'bad_request' | 'network' | 'server' | 'aborted' | 'other';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    /** A fix the UI can offer next to the error, e.g. "claudeUpdate". */
    readonly action?: string,
    /**
     * retryAfterMs: how long the provider asked to wait (Retry-After). transient: whether trying
     * again can help, when the kind alone does not say (e.g. a CLI that exited mid-answer).
     */
    readonly retry: { retryAfterMs?: number; transient?: boolean } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryAfterMs(): number | undefined {
    return this.retry.retryAfterMs;
  }
}

/** Error codes of a connection that failed or was cut (Node sockets, undici). */
const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
/**
 * Messages of the same, lower case and as whole words (fetch says "fetch failed", a cut stream
 * "terminated"), so "Unterminated string in JSON" is not one.
 */
const CONNECTION_TEXTS = /\b(?:fetch failed|terminated|socket hang up|other side closed|network error|econnreset|connection reset|connection error|premature close)\b/;

/** A connection that failed or broke off mid-stream (worth another try), as opposed to an answer the server gave. */
export function isConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
    if (CONNECTION_TEXTS.test(current.message.toLowerCase())) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Response headers as an SDK error carries them (fetch Headers, or a plain record). */
export type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined> | null | undefined;

/** The wait a response asked for, from retry-after-ms or Retry-After (seconds or an HTTP date); undefined when none. */
export function retryAfterFrom(headers: HeaderSource, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(name: string): string | null }).get(name)?.trim() || undefined;
    const value = (headers as Record<string, string | string[] | undefined>)[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  };
  const ms = get('retry-after-ms');
  if (ms !== undefined && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const raw = get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export class AbortedError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortedError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortedError ||
    (error instanceof ProviderError && error.kind === 'aborted') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
