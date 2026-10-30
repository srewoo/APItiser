export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /**
   * Predicate deciding whether a thrown error is worth retrying. Defaults to
   * `defaultShouldRetry`, which retries transient failures (network errors, 408/429, 5xx) but
   * NOT permanent client errors (a 401/404 is retried three times for nothing otherwise).
   */
  shouldRetry?: (error: unknown) => boolean;
}

/** An Error carrying the HTTP status that produced it, so retry logic can classify it. */
export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Retry transient failures only: network/unknown errors, request timeout, rate limit, 5xx. */
export const defaultShouldRetry = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  // No status → network error, abort surfaced elsewhere, parse failure: worth one more try.
  return true;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Operation aborted'));
      },
      { once: true }
    );
  });

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new Error('Operation aborted');
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) {
        break;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry operation failed');
}
