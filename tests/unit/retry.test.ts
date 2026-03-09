import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '@background/utils/retry';

describe('withRetry', () => {
  it('retries failed attempts and returns success', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(() => fn(), { retries: 2, baseDelayMs: 1 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
