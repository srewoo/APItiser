import type { LLMProvider } from '@shared/types';

/**
 * Reasoning ("thinking") models reject the classic sampling controls. Sending
 * `temperature`/`top_p` to them is a 400 on OpenAI's o-series and gpt-5 family, and on
 * Claude 4.x (Opus 4.6+/Sonnet 4.6/Opus 4.7/4.8/Fable 5). They also bill internal
 * reasoning tokens and, on OpenAI, require `max_completion_tokens` instead of `max_tokens`.
 * Centralise the detection so every adapter handles temperature consistently.
 */

/** OpenAI reasoning models: o1/o3/o4… and the gpt-5 family. gpt-4.1 / gpt-4o are NOT. */
export const isOpenAiReasoningModel = (model: string): boolean =>
  /^o\d/i.test(model) || /^gpt-5/i.test(model);

/** Claude models that reject temperature (the 4.x reasoning family and Fable/Mythos). */
export const isClaudeReasoningModel = (model: string): boolean =>
  /claude-(opus-4|sonnet-4-6|haiku-4|fable-5|mythos)/i.test(model);

export const isReasoningModel = (provider: LLMProvider, model: string): boolean => {
  if (provider === 'openai') {
    return isOpenAiReasoningModel(model);
  }
  if (provider === 'claude') {
    return isClaudeReasoningModel(model);
  }
  // Gemini "thinking" models (2.5/3) still accept temperature, so they are not treated
  // as temperature-rejecting here.
  return false;
};

/**
 * The temperature value to send for a given model, or `undefined` when it must be omitted
 * entirely (reasoning models). `configured` is the user-chosen temperature.
 */
export const resolveTemperature = (
  provider: LLMProvider,
  model: string,
  configured: number | undefined
): number | undefined => {
  if (isReasoningModel(provider, model)) {
    return undefined;
  }
  return typeof configured === 'number' ? configured : 0.2;
};

/** OpenAI reasoning models cap completions via `max_completion_tokens`, not `max_tokens`. */
export const openAiTokenField = (model: string): 'max_tokens' | 'max_completion_tokens' =>
  isOpenAiReasoningModel(model) ? 'max_completion_tokens' : 'max_tokens';
