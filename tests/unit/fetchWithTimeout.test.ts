import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '@background/llm/fetchWithTimeout';

/**
 * A mock fetch that hangs until the AbortSignal fires, then rejects —
 * mirroring the behaviour of the real fetch() in browsers/Node.
 */
const signalAwareHangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      reject(new DOMException('AbortError', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => {
      reject(new DOMException('AbortError', 'AbortError'));
    });
  });
});

const instantFetch = (): Promise<Response> =>
  Promise.resolve(new Response('ok', { status: 200 }));

beforeEach(() => {
  vi.useFakeTimers();
  signalAwareHangingFetch.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchWithTimeout — soft timeout', () => {
  it('aborts and throws a timeout error if the request hangs longer than timeoutMs', async () => {
    vi.stubGlobal('fetch', signalAwareHangingFetch);

    const promise = fetchWithTimeout(
      'https://example.com',
      { method: 'GET' },
      { timeoutMs: 5000, hardTimeoutMs: 60000 }
    );

    // Attach the rejection handler BEFORE advancing timers to avoid unhandled rejection warnings
    const result = expect(promise).rejects.toThrow(/timed out after 5s/i);
    await vi.runAllTimersAsync();
    await result;
  });
});

describe('fetchWithTimeout — hard timeout', () => {
  it('aborts and throws a hard timeout error when hard limit is exceeded', async () => {
    vi.stubGlobal('fetch', signalAwareHangingFetch);

    const promise = fetchWithTimeout(
      'https://example.com',
      { method: 'GET' },
      { timeoutMs: 10000, hardTimeoutMs: 8000 }
    );

    const result = expect(promise).rejects.toThrow(/exceeded hard timeout after 8s/i);
    await vi.runAllTimersAsync();
    await result;
  });
});

describe('fetchWithTimeout — successful response', () => {
  it('returns the response when the fetch completes before any timeout', async () => {
    vi.stubGlobal('fetch', instantFetch);

    const result = await fetchWithTimeout(
      'https://example.com',
      { method: 'GET' },
      { timeoutMs: 5000, hardTimeoutMs: 10000 }
    );

    expect(result.status).toBe(200);
  });
});

describe('fetchWithTimeout — parent signal cancellation', () => {
  it('aborts immediately when the parent AbortSignal is already aborted', async () => {
    vi.stubGlobal('fetch', signalAwareHangingFetch);

    const controller = new AbortController();
    controller.abort();

    // fetchWithTimeout.ts now detects signal.aborted and immediately aborts the
    // internal controller, so the mock's synchronous rejection path fires.
    const promise = fetchWithTimeout(
      'https://example.com',
      { method: 'GET' },
      { timeoutMs: 30000, hardTimeoutMs: 60000, parentSignal: controller.signal }
    );

    await expect(promise).rejects.toThrow();
  });

  it('aborts when the parent signal is aborted after the request starts', async () => {
    vi.stubGlobal('fetch', signalAwareHangingFetch);

    const controller = new AbortController();
    const promise = fetchWithTimeout(
      'https://example.com',
      { method: 'GET' },
      { timeoutMs: 30000, parentSignal: controller.signal }
    );

    controller.abort();

    await expect(promise).rejects.toThrow();
  });
});

describe('fetchWithTimeout — heartbeat resets soft timeout', () => {
  it('does not time out when the heartbeat fires regularly within the soft window', async () => {
    let resolveFetch!: (r: Response) => void;
    const hangingWithResolve = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise((resolve, reject) => {
        resolveFetch = resolve;
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('AbortError', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', hangingWithResolve);

    const promise = fetchWithTimeout(
      'https://example.com',
      { method: 'GET' },
      { timeoutMs: 5000, hardTimeoutMs: 30000, heartbeatMs: 2000 }
    );

    // Advance by 4 seconds (two heartbeats fire, resetting the soft timer each time)
    vi.advanceTimersByTime(4000);

    // No timeout yet — resolve the fetch now
    resolveFetch(new Response('ok', { status: 200 }));
    const result = await promise;
    expect(result.status).toBe(200);
  });
});
