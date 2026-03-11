import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiAdapter } from '@background/llm/openai';
import { ClaudeAdapter } from '@background/llm/claude';
import { GeminiAdapter } from '@background/llm/gemini';
import type { ApiEndpoint, GenerateContext, ProviderOptions } from '@shared/types';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const endpoint: ApiEndpoint = {
  id: 'GET::/users',
  method: 'GET',
  path: '/users',
  source: 'express',
  pathParams: [],
  queryParams: [],
  responses: [{ status: '200' }],
  auth: 'none'
};

const context: GenerateContext = {
  repo: { platform: 'github', owner: 'acme', repo: 'api' },
  framework: 'jest',
  includeCategories: ['positive', 'negative'],
  timeoutMs: 30000
};

const baseOptions: ProviderOptions = {
  apiKey: 'sk-test-key-012345678901234567890123456789',
  model: 'test-model',
  timeoutMs: 30000,
  hardTimeoutMs: 60000
};

// Successful response body with one test case
const TEST_CASE = {
  endpointId: 'GET::/users',
  category: 'positive',
  title: 'lists users successfully',
  request: { method: 'GET', path: '/users' },
  expected: { status: 200 }
};

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

const mockSuccessJson = (body: unknown) =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => ''
    })
  );

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// OpenAI adapter
// ---------------------------------------------------------------------------

describe('OpenAiAdapter', () => {
  it('calls the OpenAI completions endpoint and returns parsed tests', async () => {
    vi.stubGlobal(
      'fetch',
      mockSuccessJson({
        choices: [{ message: { content: JSON.stringify({ tests: [TEST_CASE] }) } }]
      })
    );

    const result = await new OpenAiAdapter().generateTests([endpoint], context, baseOptions);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]!.endpointId).toBe('GET::/users');
  });

  it('throws when the OpenAI API returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}), text: async () => '' }))
    );

    await expect(
      new OpenAiAdapter().generateTests([endpoint], context, baseOptions)
    ).rejects.toThrow('OpenAI call failed: 429');
  });
});

// ---------------------------------------------------------------------------
// Claude adapter
// ---------------------------------------------------------------------------

describe('ClaudeAdapter', () => {
  it('calls the Claude messages endpoint and returns parsed tests', async () => {
    vi.stubGlobal(
      'fetch',
      mockSuccessJson({
        content: [{ type: 'text', text: JSON.stringify({ tests: [TEST_CASE] }) }]
      })
    );

    const result = await new ClaudeAdapter().generateTests([endpoint], context, {
      ...baseOptions,
      apiKey: 'sk-ant-testkey-000000000000000000000000000000000000000000000000000'
    });
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]!.category).toBe('positive');
  });

  it('throws when the Claude API returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 401, json: async () => ({}), text: async () => '' }))
    );

    await expect(
      new ClaudeAdapter().generateTests([endpoint], context, baseOptions)
    ).rejects.toThrow();
  });

  it('sets max_tokens dynamically based on batch size', async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_, init?: RequestInit) => {
        capturedBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ tests: [TEST_CASE] }) }] }),
          text: async () => ''
        });
      })
    );

    // Batch of 5 endpoints → max_tokens should be max(5*500, 4000) = 4000
    const batch = Array.from({ length: 5 }, (_, i) => ({ ...endpoint, id: `GET::/item${i}` }));
    await new ClaudeAdapter().generateTests(batch, context, baseOptions);
    expect(capturedBody.max_tokens).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

describe('GeminiAdapter', () => {
  it('calls the Gemini generateContent endpoint and returns parsed tests', async () => {
    vi.stubGlobal(
      'fetch',
      mockSuccessJson({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ tests: [TEST_CASE] }) }] } }]
      })
    );

    const result = await new GeminiAdapter().generateTests([endpoint], context, {
      ...baseOptions,
      apiKey: 'AIzaTestKeyWithSufficientLengthForValidation123456'
    });
    expect(result.tests).toHaveLength(1);
  });

  it('sends systemInstruction (not a user message) to the Gemini API', async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_, init?: RequestInit) => {
        capturedBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ tests: [TEST_CASE] }) }] } }]
          }),
          text: async () => ''
        });
      })
    );

    await new GeminiAdapter().generateTests([endpoint], context, baseOptions);

    // systemInstruction must be top-level, not buried in contents
    expect(capturedBody).toHaveProperty('systemInstruction');
    const contents = capturedBody.contents as Array<{ role: string }>;
    expect(contents.every((c) => c.role !== 'system')).toBe(true);
  });

  it('throws when the Gemini API returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 403, json: async () => ({}), text: async () => '' }))
    );

    await expect(
      new GeminiAdapter().generateTests([endpoint], context, baseOptions)
    ).rejects.toThrow();
  });
});
