import { describe, expect, it, vi } from 'vitest';
import { withRetry, HttpError, defaultShouldRetry } from '@background/utils/retry';

describe('withRetry', () => {
  it('retries failed attempts and returns success', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce('ok');

    const result = await withRetry(() => fn(), { retries: 2, baseDelayMs: 1 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting all retries', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('always'));

    await expect(withRetry(() => fn(), { retries: 3, baseDelayMs: 1 })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent client error (4xx that is not 408/429)', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError('not found', 404));

    await expect(withRetry(() => fn(), { retries: 3, baseDelayMs: 1 })).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient statuses (429, 5xx)', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError('rate limited', 429))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(() => fn(), { retries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors a custom shouldRetry predicate', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('nope'));
    await expect(
      withRetry(() => fn(), { retries: 3, baseDelayMs: 1, shouldRetry: () => false })
    ).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('defaultShouldRetry', () => {
  it('retries network/unknown errors (no status)', () => {
    expect(defaultShouldRetry(new Error('ECONNRESET'))).toBe(true);
  });

  it('retries 408/429/5xx and rejects other 4xx', () => {
    expect(defaultShouldRetry(new HttpError('x', 408))).toBe(true);
    expect(defaultShouldRetry(new HttpError('x', 429))).toBe(true);
    expect(defaultShouldRetry(new HttpError('x', 503))).toBe(true);
    expect(defaultShouldRetry(new HttpError('x', 400))).toBe(false);
    expect(defaultShouldRetry(new HttpError('x', 401))).toBe(false);
    expect(defaultShouldRetry(new HttpError('x', 404))).toBe(false);
  });
});
