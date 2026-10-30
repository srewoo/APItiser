import { describe, expect, it } from 'vitest';
import { modelListRequest, parseModelList, pickModel } from '@background/llm/modelList';
import { rejectedOpenAiParam } from '@background/llm/modelCapabilities';
import { LOCAL_LLM_KEY, isProviderConfigured, providerChoiceOf, providerKeyFor, settingsForChoice, usesLocalLlm } from '@shared/localLlm';
import { makeSettings } from '@shared/testing/factories';

describe('modelListRequest', () => {
  it('targets each provider list-models endpoint with its auth style', () => {
    expect(modelListRequest('openai', 'k', 'http://localhost:11434/')).toEqual({
      url: 'http://localhost:11434/v1/models',
      headers: { Authorization: 'Bearer k' }
    });
    expect(modelListRequest('claude', 'k').headers['x-api-key']).toBe('k');
    const gemini = modelListRequest('gemini', 'a b');
    expect(gemini.url).toContain('key=a%20b');
    expect(gemini.headers).toEqual({});
  });
});

describe('parseModelList', () => {
  it('keeps official OpenAI chat models, newest first, and drops non-text ones', () => {
    const body = {
      data: [
        { id: 'gpt-4o', created: 1 },
        { id: 'text-embedding-3-large', created: 9 },
        { id: 'gpt-5', created: 5 },
        { id: 'gpt-4o-realtime-preview', created: 8 },
        { id: 'o4-mini', created: 3 },
        { id: 'dall-e-3', created: 7 }
      ]
    };
    expect(parseModelList('openai', body)).toEqual(['gpt-5', 'o4-mini', 'gpt-4o']);
  });

  it('lists everything a local OpenAI-compatible server serves', () => {
    const body = { data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1:8b' }] };
    expect(parseModelList('openai', body, 'http://localhost:11434')).toEqual(['qwen2.5-coder:7b', 'llama3.1:8b']);
  });

  it('reads Claude ids in API order', () => {
    expect(parseModelList('claude', { data: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }] })).toEqual([
      'claude-opus-4-8',
      'claude-haiku-4-5'
    ]);
  });

  it('keeps only Gemini text-generation models and strips the prefix', () => {
    const body = {
      models: [
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }
      ]
    };
    expect(parseModelList('gemini', body)).toEqual(['gemini-2.5-pro']);
  });

  it('tolerates junk bodies', () => {
    expect(parseModelList('openai', null)).toEqual([]);
    expect(parseModelList('gemini', { models: 'nope' })).toEqual([]);
  });
});

describe('pickModel', () => {
  it('keeps the current model when available, else a preferred one, else the newest', () => {
    expect(pickModel(['a', 'b'], 'b', ['a'])).toBe('b');
    expect(pickModel(['a', 'b'], 'gone', ['b'])).toBe('b');
    expect(pickModel(['a', 'b'], 'gone', ['x'])).toBe('a');
    expect(pickModel([], 'cur', ['x'])).toBe('cur');
  });
});

describe('rejectedOpenAiParam', () => {
  it('names the rejected parameter', () => {
    expect(rejectedOpenAiParam("'temperature' does not support 0.2")).toBe('temperature');
    expect(rejectedOpenAiParam("'max_tokens' is not supported")).toBe('token_field');
    expect(rejectedOpenAiParam('model not found')).toBeUndefined();
  });
});

describe('local LLM helpers', () => {
  const local = makeSettings({ provider: 'openai', openAiKey: '', claudeKey: '', geminiKey: '', openAiBaseUrl: 'http://localhost:11434' });

  it('needs no key for a local OpenAI-compatible server', () => {
    expect(usesLocalLlm(local)).toBe(true);
    expect(providerKeyFor(local, 'openai')).toBe(LOCAL_LLM_KEY);
    expect(isProviderConfigured(local)).toBe(true);
  });

  it('still requires a key for hosted providers', () => {
    const hosted = { ...local, openAiBaseUrl: 'https://api.openai.com' };
    expect(usesLocalLlm(hosted)).toBe(false);
    expect(providerKeyFor(hosted, 'openai')).toBe('');
    expect(providerKeyFor(local, 'claude')).toBe('');
    expect(isProviderConfigured(hosted)).toBe(false);
  });

  it('never sends a saved OpenAI key to a local server', () => {
    expect(providerKeyFor({ ...local, openAiKey: 'sk-real' }, 'openai')).toBe(LOCAL_LLM_KEY);
    expect(providerKeyFor({ ...local, openAiKey: 'sk-real', openAiBaseUrl: 'https://api.openai.com' }, 'openai')).toBe('sk-real');
  });
});

describe('provider choices', () => {
  it('derives the dropdown value from saved settings', () => {
    expect(providerChoiceOf({ provider: 'claude', openAiBaseUrl: 'http://localhost:11434' })).toBe('claude');
    expect(providerChoiceOf({ provider: 'openai', openAiBaseUrl: 'https://api.openai.com' })).toBe('openai');
    expect(providerChoiceOf({ provider: 'openai', openAiBaseUrl: 'http://localhost:11434' })).toBe('ollama');
    expect(providerChoiceOf({ provider: 'openai', openAiBaseUrl: 'http://127.0.0.1:1234/' })).toBe('lmstudio');
    expect(providerChoiceOf({ provider: 'openai', openAiBaseUrl: 'http://localhost:8001' })).toBe('local');
  });

  it('round-trips every choice', () => {
    for (const choice of ['openai', 'claude', 'gemini', 'ollama', 'lmstudio', 'local'] as const) {
      const saved = { ...makeSettings(), ...settingsForChoice(choice) };
      expect(providerChoiceOf(saved)).toBe(choice);
    }
  });
});
