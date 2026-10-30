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
  vi.fn((..._args: unknown[]) =>
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
  it('calls the OpenAI completions endpoint and returns parsed tests with usage', async () => {
    vi.stubGlobal(
      'fetch',
      mockSuccessJson({
        choices: [{ message: { content: JSON.stringify({ tests: [TEST_CASE] }) } }],
        usage: { prompt_tokens: 900, completion_tokens: 200 }
      })
    );

    const result = await new OpenAiAdapter().generateTests([endpoint], context, baseOptions);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]!.endpointId).toBe('GET::/users');
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 200 });
  });

  it('throws when the OpenAI API returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}), text: async () => '' }))
    );

    await expect(new OpenAiAdapter().generateTests([endpoint], context, baseOptions)).rejects.toThrow(
      'OpenAI call failed: 429'
    );
  });

  it('defaults to the OpenAI host when no base URL is configured', async () => {
    const fetchMock = mockSuccessJson({
      choices: [{ message: { content: JSON.stringify({ tests: [TEST_CASE] }) } }]
    });
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiAdapter().generateTests([endpoint], context, baseOptions);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('targets a configured OpenAI-compatible base URL (trailing slash tolerated)', async () => {
    const fetchMock = mockSuccessJson({
      choices: [{ message: { content: JSON.stringify({ tests: [TEST_CASE] }) } }]
    });
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiAdapter().generateTests([endpoint], context, {
      ...baseOptions,
      baseUrl: 'http://localhost:11434/'
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:11434/v1/chat/completions');
  });
  it('drops temperature and retries when an unrecognised thinking model rejects it', async () => {
    const ok = { choices: [{ message: { content: JSON.stringify({ tests: [TEST_CASE] }) } }] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => "Unsupported value: 'temperature' does not support 0.2 with this model."
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ok, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenAiAdapter().generateTests([endpoint], context, { ...baseOptions, model: 'brand-new-thinker', temperature: 0.2 });

    expect(result.tests).toHaveLength(1);
    const first = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(first.temperature).toBe(0.2);
    expect(second).not.toHaveProperty('temperature');
  });

  it('swaps max_tokens for max_completion_tokens when the model asks for it', async () => {
    const ok = { choices: [{ message: { content: JSON.stringify({ tests: [TEST_CASE] }) } }] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ok, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAiAdapter().generateTests([endpoint], context, { ...baseOptions, model: 'brand-new-thinker', temperature: 0 });

    const second = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(second).toHaveProperty('max_completion_tokens');
    expect(second).not.toHaveProperty('max_tokens');
  });

  it('returns raw text with a custom system prompt for non-test tasks', async () => {
    const fetchMock = mockSuccessJson({ choices: [{ message: { content: '{"explanation":"x","edits":[]}' } }] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenAiAdapter().generateTests([endpoint], context, { ...baseOptions, promptOverride: 'fix it', systemOverride: 'You fix code.', rawOutput: true });
    expect(result.tests).toEqual([]);
    expect(result.rawText).toBe('{"explanation":"x","edits":[]}');
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You fix code.' });
  });

  it('fails with the API detail on a 400 that is not about a sampling/limit parameter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 400, json: async () => ({}), text: async () => 'model not found' }))
    );
    await expect(new OpenAiAdapter().generateTests([endpoint], context, baseOptions)).rejects.toThrow('400 model not found');
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

    await expect(new ClaudeAdapter().generateTests([endpoint], context, baseOptions)).rejects.toThrow();
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

    // Batch of 5 endpoints → max_tokens should be min(max(5*1200, 8000), 16000) = 8000
    const batch = Array.from({ length: 5 }, (_, i) => ({ ...endpoint, id: `GET::/item${i}` }));
    await new ClaudeAdapter().generateTests(batch, context, baseOptions);
    expect(capturedBody.max_tokens).toBe(8000);
  });

  it('marks the system prompt cacheable and reports token usage', async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_, init?: RequestInit) => {
        capturedBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ tests: [TEST_CASE] }) }],
            usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 }
          }),
          text: async () => ''
        });
      })
    );

    const result = await new ClaudeAdapter().generateTests([endpoint], context, baseOptions);
    const system = capturedBody.system as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    // input = 1200 + 800 cache-read; output = 340.
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 340 });
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

    await expect(new GeminiAdapter().generateTests([endpoint], context, baseOptions)).rejects.toThrow();
  });
});
