// Trying a model request again after a failure that may pass: a cut connection, a 5xx, an
// overloaded model, a 429 with a short Retry-After. Everything else (a bad key, a rejected
// request, a usage limit hours away) fails at once. Pure: no timers but the injected sleep.
import { AbortedError, type AIProvider, type ChatRequest, type ChatResponse, isAbortError, ProviderError, type ProviderStreamEvent } from './AIProvider';

export interface RetryTiming {
  /** First wait without a Retry-After; doubles with each attempt. */
  baseMs: number;
  /** The longest wait without a Retry-After. */
  capMs: number;
  /** A Retry-After longer than this is not waited for: the request fails (or goes to the fallback). */
  maxWaitMs: number;
}

export const DEFAULT_RETRY_TIMING: RetryTiming = { baseMs: 1_000, capMs: 30_000, maxWaitMs: 120_000 };
export const DEFAULT_MAX_RETRIES = 3;
export const MAX_RETRIES_LIMIT = 10;

export interface RetryInfo {
  /** This retry's number, from 1. */
  attempt: number;
  max: number;
  delayMs: number;
  /** When the next attempt starts (epoch ms). */
  until: number;
  error: ProviderError;
}

export interface RetryOptions {
  maxRetries: number;
  timing?: RetryTiming;
  /** Before each wait. */
  onRetry?: (info: RetryInfo) => void;
  /** After a wait, when the next attempt starts. */
  onResume?: () => void;
  /** Tests: a fixed random source and an instant clock. */
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Whether trying the same request again can help. */
export function isTransient(error: unknown, timing: RetryTiming = DEFAULT_RETRY_TIMING): boolean {
  if (isAbortError(error) || !(error instanceof ProviderError)) return false;
  if (error.retry.transient !== undefined) return error.retry.transient;
  if (error.retryAfterMs !== undefined && error.retryAfterMs > timing.maxWaitMs) return false;
  switch (error.kind) {
    case 'network':
    case 'server':
      return true;
    case 'rate_limit':
      // An HTTP 429 passes in seconds; a usage limit a CLI reports (no status, no wait) does not.
      return error.status === 429 || error.retryAfterMs !== undefined;
    default:
      return false;
  }
}

/**
 * How long to wait before retry `attempt` (0 for the first): the provider's Retry-After when it
 * gave one, else a capped exponential backoff with jitter (half fixed, half random), so clients
 * that failed together do not come back together.
 */
export function retryDelay(attempt: number, error: ProviderError, timing: RetryTiming = DEFAULT_RETRY_TIMING, random: () => number = Math.random): number {
  if (error.retryAfterMs !== undefined) return Math.min(timing.maxWaitMs, Math.max(0, error.retryAfterMs) + Math.round(random() * 250));
  const exp = Math.min(timing.capMs, timing.baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Wait, or reject with AbortedError as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * provider.chat with retries of transient failures. The provider makes one attempt per call
 * (selfRetry), so every wait is one the caller can show. Each attempt starts the turn afresh:
 * nothing of a failed attempt is kept, and no tool has run (tools run after a turn completes).
 */
export async function chatWithRetry(
  provider: AIProvider,
  request: ChatRequest,
  onEvent: (event: ProviderStreamEvent) => void,
  options: RetryOptions,
): Promise<ChatResponse> {
  const timing = options.timing ?? DEFAULT_RETRY_TIMING;
  // A value that is not a number (a hand-edited setting) falls back to the default, never to "forever".
  const max = Number.isFinite(options.maxRetries) ? Math.max(0, Math.min(MAX_RETRIES_LIMIT, Math.floor(options.maxRetries))) : DEFAULT_MAX_RETRIES;
  const now = options.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.chat({ ...request, selfRetry: true }, onEvent);
    } catch (error) {
      if (request.signal?.aborted) throw isAbortError(error) ? error : new AbortedError();
      if (attempt >= max || !isTransient(error, timing)) throw error;
      const failure = error as ProviderError;
      const delayMs = retryDelay(attempt, failure, timing, options.random);
      options.onRetry?.({ attempt: attempt + 1, max, delayMs, until: now() + delayMs, error: failure });
      await (options.sleep ?? sleep)(delayMs, request.signal);
      if (request.signal?.aborted) throw new AbortedError();
      options.onResume?.();
    }
  }
}
