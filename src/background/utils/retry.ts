export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

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

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new Error('Operation aborted');
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry operation failed');
}
