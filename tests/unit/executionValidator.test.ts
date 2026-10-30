import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  validateGeneratedTestsAgainstBaseUrl,
  buildUrl,
  isReissuableForIdempotency
} from '@background/generation/executionValidator';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { ApiEndpoint, GeneratedTestCase } from '@shared/types';

const endpoint: ApiEndpoint = {
  id: 'GET::/users/:id',
  method: 'GET',
  path: '/users/:id',
  source: 'openapi',
  auth: 'bearer',
  pathParams: [{ name: 'id', required: true, type: 'integer' }],
  queryParams: [],
  responses: [
    {
      status: '200',
      contentType: 'application/json',
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { name: 'id', required: true, type: 'integer' }
        }
      }
    }
  ]
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateGeneratedTestsAgainstBaseUrl', () => {
  it('passes when live response matches status, headers, and schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ id: 1 }),
        json: async () => ({ id: 1 })
      }))
    );

    const tests: GeneratedTestCase[] = [
      {
        endpointId: endpoint.id,
        category: 'positive',
        title: 'gets a user',
        request: {
          method: 'GET',
          path: '/users/1',
          headers: { Authorization: 'Bearer {{API_TOKEN}}' }
        },
        expected: {
          status: 200,
          contentType: 'application/json',
          jsonSchema: endpoint.responses[0].schema,
          contractChecks: ['response matches documented schema'],
          idempotent: true
        }
      }
    ];

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', runtimeApiToken: 'token' },
      tests,
      [endpoint]
    );

    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
  });

  it('reports schema and status failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ wrong: true }),
        json: async () => ({ wrong: true })
      }))
    );

    const tests: GeneratedTestCase[] = [
      {
        endpointId: endpoint.id,
        category: 'positive',
        title: 'gets a user',
        request: { method: 'GET', path: '/users/1' },
        expected: {
          status: 200,
          contentType: 'application/json',
          jsonSchema: endpoint.responses[0].schema
        }
      }
    ];

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000' },
      tests,
      [endpoint]
    );

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.failures.some((failure) => failure.type === 'status')).toBe(true);
    expect(summary.results[0]?.failures.some((failure) => failure.type === 'schema')).toBe(true);
  });

  it('executes setup steps before validation and extracts runtime auth', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ token: 'runtime-token' })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ id: 1 })
      });
    vi.stubGlobal('fetch', fetchMock);

    const tests: GeneratedTestCase[] = [
      {
        endpointId: endpoint.id,
        category: 'positive',
        title: 'gets a user with setup auth',
        request: {
          method: 'GET',
          path: '/users/1',
          headers: { Authorization: 'Bearer {{API_TOKEN}}' }
        },
        expected: {
          status: 200,
          contentType: 'application/json',
          jsonSchema: endpoint.responses[0].schema
        }
      }
    ];

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      {
        ...DEFAULT_SETTINGS,
        baseUrl: 'http://localhost:3000',
        runtimeAuthMode: 'bearer',
        runtimeSetupSteps: [
          {
            id: 'login',
            name: 'Login',
            method: 'POST',
            path: '/auth/login',
            body: { email: 'qa@example.com', password: 'secret' },
            extractJsonPaths: { apiToken: 'token' },
            expectedStatus: 200
          }
        ]
      },
      tests,
      [endpoint]
    );

    expect(summary.failed).toBe(0);
    expect(summary.setupSteps?.[0]?.success).toBe(true);
    expect(summary.setupSteps?.[0]?.extracted).toContain('apiToken');
    expect(fetchMock.mock.calls[1]?.[1]?.headers.Authorization).toBe('Bearer runtime-token');
  });

  it('skips entirely when no base URL is configured', async () => {
    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: '' },
      [
        {
          endpointId: endpoint.id,
          category: 'positive',
          title: 'gets a user',
          request: { method: 'GET', path: '/users/1' },
          expected: { status: 200 }
        }
      ],
      [endpoint]
    );
    expect(summary.attempted).toBe(0);
    expect(summary.notRunReason).toContain('Base URL');
  });

  it('reports contains, content-type and response-header mismatches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'nothing useful here',
        json: async () => ({})
      }))
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000' },
      [
        {
          endpointId: endpoint.id,
          category: 'positive',
          title: 'gets a user',
          request: { method: 'GET', path: '/users/1' },
          expected: {
            status: 200,
            contentType: 'application/json',
            contains: ['expected-substring'],
            responseHeaders: { 'X-Trace-Id': 'abc' }
          }
        }
      ],
      [endpoint]
    );

    expect(summary.failed).toBe(1);
    const types = summary.results[0]?.failures.map((f) => f.type) ?? [];
    expect(types).toContain('contains');
    expect(types).toContain('header');
  });

  it('treats a lone request that cannot connect as "server unreachable", not a failing test', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000' },
      [
        {
          endpointId: endpoint.id,
          category: 'positive',
          title: 'gets a user',
          request: { method: 'GET', path: '/users/1' },
          expected: { status: 200 }
        }
      ],
      [endpoint]
    );

    // Nothing answered at all → not a test failure (and nothing for the LLM to repair).
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.notRunReason).toContain("Couldn't reach http://localhost:3000");
  });

  it('classifies a status mismatch on a security test as an auth failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ id: 1 }),
        json: async () => ({ id: 1 })
      }))
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000' },
      [
        {
          endpointId: endpoint.id,
          category: 'security',
          title: 'rejects unauthenticated access',
          request: { method: 'GET', path: '/users/1' },
          expected: { status: 401 }
        }
      ],
      [endpoint]
    );

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.failures.some((f) => f.type === 'auth')).toBe(true);
  });

  it('runs anyway (with a warning) when runtime auth is missing — does not skip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ error: 'unauthorized' }),
        json: async () => ({ error: 'unauthorized' })
      }))
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      {
        ...DEFAULT_SETTINGS,
        baseUrl: 'http://localhost:3000',
        runtimeAuthMode: 'bearer'
      },
      [
        {
          endpointId: endpoint.id,
          category: 'positive',
          title: 'needs auth',
          request: {
            method: 'GET',
            path: '/users/1',
            headers: { Authorization: 'Bearer {{API_TOKEN}}' }
          },
          expected: {
            status: 200
          }
        }
      ],
      [endpoint]
    );

    // It executes the test (not skipped), the auth-needing test fails on the 401, and a
    // warning explains the missing credential — instead of a 0/0 hard skip.
    expect(summary.attempted).toBe(1);
    expect(summary.notRunReason).toBeUndefined();
    expect(summary.failed).toBe(1);
    expect((summary.warnings ?? []).some((w) => /token|Running anyway/i.test(w))).toBe(true);
  });

  it('accepts any 4xx for a negative test rather than the exact declared code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ error: 'unprocessable' }),
        json: async () => ({ error: 'unprocessable' })
      }))
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', runtimeApiToken: 'token' },
      [
        {
          endpointId: endpoint.id,
          category: 'negative',
          title: 'rejects bad input',
          request: { method: 'GET', path: '/users/1', headers: { Authorization: 'Bearer {{API_TOKEN}}' } },
          // Declares 400 but the API answers 422 — both are client errors, so this must pass.
          expected: { status: 400 }
        }
      ],
      [endpoint]
    );

    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
  });

  it('resolves {{NAME}} path placeholders from a setup-captured runtime value (resource chaining)', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrls.push(String(url));
        // First call is the setup step that creates a resource and returns its id.
        if (String(url).includes('/setup/users')) {
          return {
            ok: true,
            status: 201,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () => JSON.stringify({ data: { id: 4242 } }),
            json: async () => ({ data: { id: 4242 } })
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ id: 4242 }),
          json: async () => ({ id: 4242 })
        };
      })
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      {
        ...DEFAULT_SETTINGS,
        baseUrl: 'http://localhost:3000',
        runtimeApiToken: 'token',
        runtimeSetupSteps: [
          {
            id: 'create-user',
            name: 'create a user',
            method: 'POST',
            path: '/setup/users',
            expectedStatus: 201,
            extractValues: { USER_ID: 'data.id' }
          }
        ]
      },
      [
        {
          endpointId: endpoint.id,
          category: 'positive',
          title: 'gets the created user',
          request: { method: 'GET', path: '/users/{{USER_ID}}', headers: { Authorization: 'Bearer {{API_TOKEN}}' } },
          expected: { status: 200 }
        }
      ],
      [endpoint]
    );

    expect(summary.failed).toBe(0);
    // The {{USER_ID}} token must have been resolved to the captured id before the request.
    expect(requestedUrls.some((url) => url.includes('/users/4242'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('{{USER_ID}}'))).toBe(false);
  });
});

describe('buildUrl', () => {
  it('preserves a base path prefix instead of dropping it', () => {
    expect(buildUrl('https://api.example.com/v1', '/users')).toBe('https://api.example.com/v1/users');
    expect(buildUrl('https://api.example.com/v1/', '/users/1')).toBe('https://api.example.com/v1/users/1');
  });

  it('handles a bare origin and appends query params', () => {
    expect(buildUrl('http://localhost:3000', '/health')).toBe('http://localhost:3000/health');
    expect(buildUrl('http://localhost:3000', '/items', { page: 2 })).toBe('http://localhost:3000/items?page=2');
  });

  it('uses an absolute path as-is', () => {
    expect(buildUrl('https://api.example.com/v1', 'https://other.host/x')).toBe('https://other.host/x');
  });
});

describe('isReissuableForIdempotency', () => {
  it('re-issues safe idempotent methods but never DELETE', () => {
    expect(isReissuableForIdempotency('GET')).toBe(true);
    expect(isReissuableForIdempotency('put')).toBe(true);
    expect(isReissuableForIdempotency('HEAD')).toBe(true);
    // DELETE is spec-idempotent but destructive to re-issue → excluded.
    expect(isReissuableForIdempotency('DELETE')).toBe(false);
    expect(isReissuableForIdempotency('POST')).toBe(false);
  });
});

describe('validation concurrency and time budget', () => {
  it('runs independent tests concurrently (peak in-flight > 1)', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ id: 1 }),
          json: async () => ({ id: 1 })
        };
      })
    );

    const tests: GeneratedTestCase[] = Array.from({ length: 6 }, (_, i) => ({
      endpointId: endpoint.id,
      category: 'positive',
      title: `case ${i}`,
      request: { method: 'GET', path: '/users/1' },
      expected: { status: 200 }
    }));

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', validationConcurrency: 4 },
      tests,
      [endpoint]
    );

    expect(summary.attempted).toBe(6);
    expect(peak).toBeGreaterThan(1);
  });

  it('runs serially when the suite declares lifecycle ordering', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ id: 1 }),
          json: async () => ({ id: 1 })
        };
      })
    );

    const tests: GeneratedTestCase[] = [
      { endpointId: endpoint.id, category: 'positive', title: 'create', order: 0, isSetup: true, request: { method: 'GET', path: '/users/1' }, expected: { status: 200 } },
      { endpointId: endpoint.id, category: 'positive', title: 'use', order: 1, request: { method: 'GET', path: '/users/1' }, expected: { status: 200 } }
    ];

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', validationConcurrency: 4 },
      tests,
      [endpoint]
    );

    expect(summary.attempted).toBe(2);
    expect(peak).toBe(1);
  });

  it('stops launching new tests and reports skipped when the time budget is exceeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ id: 1 }),
          json: async () => ({ id: 1 })
        };
      })
    );

    const tests: GeneratedTestCase[] = Array.from({ length: 8 }, (_, i) => ({
      endpointId: endpoint.id,
      category: 'positive',
      title: `case ${i}`,
      request: { method: 'GET', path: '/users/1' },
      expected: { status: 200 }
    }));

    // Budget of 1ms guarantees the deadline passes after the first wave.
    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', validationConcurrency: 2, validationBudgetMs: 1 },
      tests,
      [endpoint]
    );

    expect(summary.skipped).toBeGreaterThan(0);
    expect(summary.warnings?.some((w) => w.includes('time budget'))).toBe(true);
  });
});

describe('unreachable server', () => {
  const settings = { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', retryOnRateLimit: false };
  const makeTest = (title: string, path = '/users/1'): GeneratedTestCase => ({
    endpointId: endpoint.id,
    category: 'positive',
    title,
    request: { method: 'GET', path },
    expected: { status: 200 }
  });

  it('reports one clear "not run" reason instead of N failing tests when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const summary = await validateGeneratedTestsAgainstBaseUrl(settings, [makeTest('a'), makeTest('b')], [endpoint]);

    expect(summary).toMatchObject({ attempted: 0, passed: 0, failed: 0, skipped: 2, results: [] });
    expect(summary.notRunReason).toContain("Couldn't reach http://localhost:3000");
    expect(summary.targetBaseUrl).toBe('http://localhost:3000');
  });

  it('keeps real results when only some requests fail to connect, with a readable reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"id":1}'
        })
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    );

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...settings, validationConcurrency: 1 },
      [makeTest('ok'), makeTest('dropped')],
      [endpoint]
    );

    expect(summary).toMatchObject({ attempted: 2, passed: 1, failed: 1 });
    expect(summary.notRunReason).toBeUndefined();
    expect(summary.results[1]!.failures[0]!.message).toBe(
      'Could not connect to http://localhost:3000 (Failed to fetch) — is the API running?'
    );
  });
});

describe('failure verdicts', () => {
  it('marks a 500 as a likely API bug with a reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Headers(), text: async () => 'boom' }));
    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', retryOnRateLimit: false },
      [{ endpointId: endpoint.id, category: 'positive', title: 'gets a user', request: { method: 'GET', path: '/users/1' }, expected: { status: 200 } }],
      [endpoint]
    );
    expect(summary.results[0]).toMatchObject({ success: false, verdict: 'api' });
    expect(summary.results[0]!.verdictReason).toContain('bug in the API');
  });
});
