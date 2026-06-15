import { describe, expect, it } from 'vitest';
import {
  isOpenAiReasoningModel,
  isReasoningModel,
  resolveTemperature,
  openAiTokenField
} from '@background/llm/modelCapabilities';

describe('modelCapabilities', () => {
  it('detects OpenAI reasoning models (o-series + gpt-5), not classic models', () => {
    for (const m of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      expect(isOpenAiReasoningModel(m)).toBe(true);
    }
    for (const m of ['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini']) {
      expect(isOpenAiReasoningModel(m)).toBe(false);
    }
  });

  it('treats Claude 4.x / Fable as temperature-rejecting reasoning models', () => {
    expect(isReasoningModel('claude', 'claude-opus-4-8')).toBe(true);
    expect(isReasoningModel('claude', 'claude-sonnet-4-6')).toBe(true);
    expect(isReasoningModel('claude', 'claude-fable-5')).toBe(true);
  });

  it('does not treat Gemini thinking models as temperature-rejecting', () => {
    expect(isReasoningModel('gemini', 'gemini-2.5-pro')).toBe(false);
  });

  it('omits temperature for reasoning models and keeps it for classic models', () => {
    // undefined => the adapter must drop the field entirely (sending it 400s).
    expect(resolveTemperature('openai', 'gpt-5', 0.2)).toBeUndefined();
    expect(resolveTemperature('claude', 'claude-opus-4-8', 0.2)).toBeUndefined();
    expect(resolveTemperature('openai', 'gpt-4.1-mini', 0.5)).toBe(0.5);
    expect(resolveTemperature('openai', 'gpt-4.1-mini', undefined)).toBe(0.2);
    expect(resolveTemperature('gemini', 'gemini-2.5-pro', 0.7)).toBe(0.7);
  });

  it('uses max_completion_tokens for OpenAI reasoning models, max_tokens otherwise', () => {
    expect(openAiTokenField('gpt-5')).toBe('max_completion_tokens');
    expect(openAiTokenField('o4-mini')).toBe('max_completion_tokens');
    expect(openAiTokenField('gpt-4o')).toBe('max_tokens');
  });
});
