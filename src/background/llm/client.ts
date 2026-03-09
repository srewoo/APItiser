import type { LLMProvider, LLMProviderAdapter } from '@shared/types';
import { OpenAiAdapter } from './openai';
import { ClaudeAdapter } from './claude';
import { GeminiAdapter } from './gemini';

const providers: Record<LLMProvider, LLMProviderAdapter> = {
  openai: new OpenAiAdapter(),
  claude: new ClaudeAdapter(),
  gemini: new GeminiAdapter()
};

export const getProviderAdapter = (provider: LLMProvider): LLMProviderAdapter => providers[provider];
