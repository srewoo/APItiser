import type { LLMProvider, TokenUsage } from '@shared/types';

/**
 * Rough public list prices in USD per 1M tokens, used only for an advisory cost estimate shown
 * in the UI. Matched by longest-prefix so family names ("gpt-5", "claude-opus-4") cover their
 * dated variants. Unknown models fall back to a mid-range default rather than throwing.
 */
interface Price {
  in: number;
  out: number;
}

const PRICE_TABLE: Array<{ prefix: string; price: Price }> = [
  // OpenAI
  { prefix: 'gpt-5-mini', price: { in: 0.25, out: 2 } },
  { prefix: 'gpt-5', price: { in: 1.25, out: 10 } },
  { prefix: 'o4-mini', price: { in: 1.1, out: 4.4 } },
  { prefix: 'gpt-4.1-mini', price: { in: 0.4, out: 1.6 } },
  { prefix: 'gpt-4.1', price: { in: 2, out: 8 } },
  { prefix: 'gpt-4o', price: { in: 2.5, out: 10 } },
  // Claude
  { prefix: 'claude-opus-4', price: { in: 15, out: 75 } },
  { prefix: 'claude-sonnet-4', price: { in: 3, out: 15 } },
  { prefix: 'claude-haiku-4', price: { in: 1, out: 5 } },
  { prefix: 'claude-fable', price: { in: 3, out: 15 } },
  // Gemini
  { prefix: 'gemini-2.5-pro', price: { in: 1.25, out: 10 } },
  { prefix: 'gemini-2.5-flash', price: { in: 0.3, out: 2.5 } },
  { prefix: 'gemini-2.0-flash', price: { in: 0.1, out: 0.4 } },
  { prefix: 'gemini-1.5-pro', price: { in: 1.25, out: 5 } }
];

const DEFAULT_PRICE: Record<LLMProvider, Price> = {
  openai: { in: 2, out: 8 },
  claude: { in: 3, out: 15 },
  gemini: { in: 0.3, out: 2.5 }
};

const priceFor = (provider: LLMProvider, model: string): Price => {
  const match = PRICE_TABLE.find((entry) => model.startsWith(entry.prefix));
  return match?.price ?? DEFAULT_PRICE[provider];
};

/** Estimated USD cost for the given token usage on a model. Returns undefined if no usage. */
export const estimateCostUsd = (
  provider: LLMProvider,
  model: string,
  usage: TokenUsage | undefined
): number | undefined => {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return undefined;
  const price = priceFor(provider, model);
  const cost = (usage.inputTokens / 1_000_000) * price.in + (usage.outputTokens / 1_000_000) * price.out;
  // Round to 4 decimals — these runs are typically fractions of a cent to a few cents.
  return Math.round(cost * 10_000) / 10_000;
};
