import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '@background/llm/pricing';

describe('estimateCostUsd', () => {
  it('computes cost from a known model price', () => {
    // gpt-4.1: $2/1M in, $8/1M out. 1M in + 1M out = 2 + 8 = 10.
    expect(estimateCostUsd('openai', 'gpt-4.1', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(10);
  });

  it('matches by longest prefix (gpt-5-mini before gpt-5)', () => {
    const mini = estimateCostUsd('openai', 'gpt-5-mini', { inputTokens: 1_000_000, outputTokens: 0 });
    const full = estimateCostUsd('openai', 'gpt-5', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(mini).toBe(0.25);
    expect(full).toBe(1.25);
  });

  it('falls back to a provider default for unknown models', () => {
    expect(estimateCostUsd('claude', 'some-future-model', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(3);
  });

  it('returns undefined when there is no usage', () => {
    expect(estimateCostUsd('openai', 'gpt-4.1', undefined)).toBeUndefined();
    expect(estimateCostUsd('openai', 'gpt-4.1', { inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});
