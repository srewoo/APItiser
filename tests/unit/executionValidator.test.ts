import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateGeneratedTestsAgainstBaseUrl } from '@background/generation/executionValidator';
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
  responses: [{
    status: '200',
    contentType: 'application/json',
    schema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { name: 'id', required: true, type: 'integer' }
      }
    }
  }]
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateGeneratedTestsAgainstBaseUrl', () => {
  it('passes when live response matches status, headers, and schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ id: 1 }),
      json: async () => ({ id: 1 })
    })));

    const tests: GeneratedTestCase[] = [{
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
    }];

    const summary = await validateGeneratedTestsAgainstBaseUrl(
      { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', runtimeApiToken: 'token' },
      tests,
      [endpoint]
    );

    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
  });

  it('reports schema and status failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ wrong: true }),
      json: async () => ({ wrong: true })
    })));

    const tests: GeneratedTestCase[] = [{
      endpointId: endpoint.id,
      category: 'positive',
      title: 'gets a user',
      request: { method: 'GET', path: '/users/1' },
      expected: {
        status: 200,
        contentType: 'application/json',
        jsonSchema: endpoint.responses[0].schema
      }
    }];

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
    const fetchMock = vi.fn()
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

    const tests: GeneratedTestCase[] = [{
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
    }];

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

  it('marks validation as review-required when runtime auth is missing', async () => {
    const summary = await validateGeneratedTestsAgainstBaseUrl(
      {
        ...DEFAULT_SETTINGS,
        baseUrl: 'http://localhost:3000',
        runtimeAuthMode: 'bearer'
      },
      [{
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
      }],
      [endpoint]
    );

    expect(summary.attempted).toBe(0);
    expect(summary.notRunReason).toContain('API token');
  });
});
