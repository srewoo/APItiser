interface FetchWithTimeoutOptions {
  timeoutMs: number;
  hardTimeoutMs?: number;
  heartbeatMs?: number;
  onHeartbeat?: (elapsedMs: number) => void | Promise<void>;
  parentSignal?: AbortSignal;
}

export const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit,
  options: FetchWithTimeoutOptions
): Promise<Response> => {
  const controller = new AbortController();
  let softTimedOut = false;
  let hardTimedOut = false;
  let softTimeout: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();

  const resetSoftTimeout = () => {
    if (softTimeout) {
      clearTimeout(softTimeout);
    }
    softTimeout = setTimeout(() => {
      softTimedOut = true;
      controller.abort();
    }, options.timeoutMs);
  };

  resetSoftTimeout();

  const hardTimeout = setTimeout(() => {
    hardTimedOut = true;
    controller.abort();
  }, options.hardTimeoutMs ?? options.timeoutMs);

  const heartbeatTimer = options.heartbeatMs
    ? setInterval(() => {
        resetSoftTimeout();
        if (options.onHeartbeat) {
          void Promise.resolve(options.onHeartbeat(Date.now() - startedAt)).catch(() => undefined);
        }
      }, options.heartbeatMs)
    : undefined;

  const forwardAbort = () => controller.abort();
  if (options.parentSignal?.aborted) {
    // Signal was already aborted before we could listen — abort immediately.
    forwardAbort();
  } else {
    options.parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (hardTimedOut) {
      throw new Error(`Request exceeded hard timeout after ${Math.round((options.hardTimeoutMs ?? options.timeoutMs) / 1000)}s`);
    }
    if (softTimedOut) {
      throw new Error(`Request timed out after ${Math.round(options.timeoutMs / 1000)}s without heartbeat`);
    }
    throw error;
  } finally {
    if (softTimeout) {
      clearTimeout(softTimeout);
    }
    clearTimeout(hardTimeout);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    options.parentSignal?.removeEventListener('abort', forwardAbort);
  }
};
