/**
 * Provider model discovery. The same "list models" call proves a key works AND tells us which
 * models that key can use, so the model picker shows what the account actually has (or, for a
 * local server, what is installed) instead of a hard-coded list.
 */
import type { LLMProvider } from '@shared/types';
import { DEFAULT_OPENAI_BASE_URL } from '@shared/constants';

export interface ModelListRequest {
  url: string;
  headers: Record<string, string>;
}

const OPENAI_ORIGIN = 'https://api.openai.com';
// Non-text models the official OpenAI list includes; they can't generate test JSON.
const OPENAI_NON_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|computer-use|dall-e|whisper)/i;
const GEMINI_NON_CHAT = /(embedding|tts|image|live|audio|aqa)/i;

const openAiBase = (baseUrl?: string): string => (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');

export const modelListRequest = (provider: LLMProvider, key: string, baseUrl?: string): ModelListRequest => {
  if (provider === 'openai') {
    return { url: `${openAiBase(baseUrl)}/v1/models`, headers: { Authorization: `Bearer ${key}` } };
  }
  if (provider === 'claude') {
    return {
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    };
  }
  // Gemini takes the key as a query param; avoid putting it in a header.
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
    headers: {}
  };
};

interface OpenAiModel { id?: unknown; created?: unknown }
interface GeminiModel { name?: unknown; supportedGenerationMethods?: unknown }

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Extract usable text-generation model ids from a list-models response body, newest first. */
export const parseModelList = (provider: LLMProvider, body: unknown, baseUrl?: string): string[] => {
  const json = (body ?? {}) as { data?: unknown; models?: unknown };
  if (provider === 'gemini') {
    return asArray(json.models)
      .map((model) => model as GeminiModel)
      .filter((model) => asArray(model.supportedGenerationMethods).includes('generateContent'))
      .map((model) => String(model.name ?? '').replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini') && !GEMINI_NON_CHAT.test(id));
  }
  const entries = asArray(json.data).map((model) => model as OpenAiModel).filter((model) => typeof model.id === 'string');
  if (provider === 'claude') {
    return entries.map((model) => model.id as string); // API already returns newest first
  }
  const official = openAiBase(baseUrl).startsWith(OPENAI_ORIGIN);
  // Local servers / gateways: list everything they serve — the user loaded those on purpose.
  const usable = official
    ? entries.filter((model) => /^(gpt-|o\d|chatgpt-)/i.test(model.id as string) && !OPENAI_NON_CHAT.test(model.id as string))
    : entries;
  return usable
    .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
    .map((model) => model.id as string);
};

/**
 * Keep the current model if the account has it; otherwise the first of our preferred defaults
 * the account has; otherwise the newest model listed.
 */
export const pickModel = (models: string[], current: string | undefined, preferred: readonly string[]): string | undefined => {
  if (!models.length) return current;
  if (current && models.includes(current)) return current;
  return preferred.find((model) => models.includes(model)) ?? models[0];
};
