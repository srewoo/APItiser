import type { LLMProvider, LLMProviderAdapter } from '@shared/types';
import { OpenAiAdapter } from './openai';
import { ClaudeAdapter } from './claude';
import { GeminiAdapter } from './gemini';

const loadedProviders = new Map<LLMProvider, LLMProviderAdapter>();

export const loadProviderAdapter = async (provider: LLMProvider): Promise<LLMProviderAdapter> => {
  const cached = loadedProviders.get(provider);
  if (cached) {
    return cached;
  }

  let adapter: LLMProviderAdapter;
  if (provider === 'openai') {
    adapter = new OpenAiAdapter();
  } else if (provider === 'claude') {
    adapter = new ClaudeAdapter();
  } else {
    adapter = new GeminiAdapter();
  }

  loadedProviders.set(provider, adapter);
  return adapter;
};
