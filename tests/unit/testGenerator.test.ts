import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assessGeneratedTestQuality, generateTestSuite, normalizeGeneratedTests, repairTestsFromValidation } from '@background/generation/testGenerator';
import type { ApiEndpoint, ExtensionSettings, GeneratedTestCase, GenerateContext, ProviderOptions } from '@shared/types';

const generateTestsMock = vi.fn<
  (batch: ApiEndpoint[], context: GenerateContext, options: ProviderOptions) => Promise<{ tests: GeneratedTestCase[] }>
>();

vi.mock('@background/llm/client', () => ({
  loadProviderAdapter: async () => ({
    provider: 'openai',
    generateTests: generateTestsMock
  })
}));

const baseSettings: ExtensionSettings = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  framework: 'jest',
  includeCategories: ['positive', 'negative', 'edge', 'security'],
  testDirectories: ['tests'],
  skipExistingTests: true,
  batchSize: 1,
  timeoutMs: 120000,
  openAiKey: 'test-key'
};

beforeEach(() => {
  generateTestsMock.mockReset();
});

describe('normalizeGeneratedTests', () => {
  it('drops unknown endpoints and normalizes method, path, and auth headers', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'openapi',
        auth: 'bearer',
        pathParams: [{ name: 'id', required: true, type: 'integer' }],
        queryParams: [],
        responses: [{ status: '200' }]
      }
    ];

    const tests = normalizeGeneratedTests(
      [
        {
          endpointId: 'GET::/users/:id',
          category: 'positive',
          title: 'gets user',
          request: {
            method: 'POST',
            path: '/users/:id'
          },
          expected: {
            status: '200'
          }
        },
        {
          endpointId: 'missing-endpoint',
          title: 'bad'
        }
      ],
      ['positive', 'negative', 'edge', 'security'],
      endpoints
    );

    expect(tests).toHaveLength(1);
    const first = tests[0];
    expect(first).toBeDefined();
    expect(first!.request.method).toBe('GET');
    expect(first!.request.path).toBe('/users/1');
    expect(first?.request.headers?.Authorization).toBe('Bearer {{API_TOKEN}}');
  });

  it('flags missing categories and unresolved concrete paths for repair', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'openapi',
        auth: 'bearer',
        pathParams: [{ name: 'id', required: true, type: 'integer' }],
        queryParams: [],
        responses: [{ status: '200' }]
      }
    ];

    const quality = assessGeneratedTestQuality(
      endpoints,
      [
        {
          endpointId: 'GET::/users/:id',
          category: 'positive',
          title: 'gets user',
          request: {
            method: 'GET',
            path: '/users/:id'
          },
          expected: {
            status: 200
          }
        }
      ],
      ['positive', 'negative', 'security']
    );

    expect(quality.passed).toBe(false);
    expect(quality.issues.some((issue) => issue.message.includes('Missing negative test'))).toBe(true);
    expect(quality.issues.some((issue) => issue.message.includes('Missing security test'))).toBe(true);
    expect(quality.issues.some((issue) => issue.message.includes('No concrete path values'))).toBe(true);
  });

  it('preserves partial tests when repair output is still below the quality threshold', async () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'openapi',
        auth: 'bearer',
        pathParams: [{ name: 'id', required: true, type: 'integer' }],
        queryParams: [],
        responses: [{ status: '200' }]
      }
    ];

    generateTestsMock
      .mockResolvedValueOnce({
        tests: [
          {
            endpointId: 'GET::/users/:id',
            category: 'positive',
            title: 'generated test',
            request: { method: 'GET', path: '/users/:id' },
            expected: { status: 200 }
          }
        ]
      })
      .mockResolvedValue({
        tests: [
          {
            endpointId: 'GET::/users/:id',
            category: 'positive',
            title: 'still generic',
            request: { method: 'GET', path: '/users/:id' },
            expected: { status: 200 }
          }
        ]
      });

    const result = await generateTestSuite({
      settings: baseSettings,
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints
    });

    // The job should succeed but the diagnostics should show that it failed the assessment
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].title).toBe('still generic');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].assessment.passed).toBe(false);
  });

  it('accepts repaired output and reports diagnostics through batch progress', async () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'POST::/users',
        method: 'POST',
        path: '/users',
        source: 'openapi',
        auth: 'bearer',
        pathParams: [],
        queryParams: [],
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { name: 'email', required: true, type: 'string', format: 'email' }
          }
        },
        responses: [{ status: '201' }]
      }
    ];

    const repairedTests = [
      {
        endpointId: 'POST::/users',
        category: 'positive',
        title: 'creates user with valid email',
        request: { method: 'POST', path: '/users', body: { email: 'user@example.com' } },
        expected: { status: 201, contains: ['user'] }
      },
      {
        endpointId: 'POST::/users',
        category: 'negative',
        title: 'rejects missing email on create user',
        request: { method: 'POST', path: '/users', body: {} },
        expected: { status: 400 }
      },
      {
        endpointId: 'POST::/users',
        category: 'edge',
        title: 'handles long email input on create user',
        request: { method: 'POST', path: '/users', body: { email: 'x'.repeat(128) + '@example.com' } },
        expected: { status: 400 }
      },
      {
        endpointId: 'POST::/users',
        category: 'security',
        title: 'rejects unauthorized create user request',
        request: { method: 'POST', path: '/users', headers: {} },
        expected: { status: 401 }
      }
    ] satisfies GeneratedTestCase[];

    const repairedQuality = assessGeneratedTestQuality(
      endpoints,
      normalizeGeneratedTests(repairedTests, baseSettings.includeCategories, endpoints),
      baseSettings.includeCategories
    );
    expect(repairedQuality.passed).toBe(true);

    generateTestsMock
      .mockResolvedValueOnce({
        tests: [
          {
            endpointId: 'POST::/users',
            category: 'positive',
            title: 'generated test',
            request: { method: 'POST', path: '/users' },
            expected: { status: 201 }
          }
        ]
      })
      .mockResolvedValueOnce({
        tests: repairedTests
      });

    const onBatchComplete = vi.fn();
    const result = await generateTestSuite({
      settings: baseSettings,
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints,
      onBatchComplete
    });

    expect(result.tests).toHaveLength(4);
    expect(result.diagnostics[0]?.repairAttempted).toBe(true);
    expect(result.diagnostics[0]?.assessment.passed).toBe(true);
    expect(onBatchComplete).toHaveBeenCalledWith(expect.objectContaining({
      batchDiagnostics: expect.objectContaining({
        repairAttempted: true
      })
    }));
  });

  it('preserves stronger assertions when validation repair returns a weaker replacement', async () => {
    const endpoints: ApiEndpoint[] = [
      {
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
      }
    ];

    const currentTests: GeneratedTestCase[] = [
      {
        endpointId: 'GET::/users/:id',
        category: 'positive',
        title: 'gets user by id',
        request: {
          method: 'GET',
          path: '/users/1',
          headers: { Authorization: 'Bearer {{API_TOKEN}}' }
        },
        expected: {
          status: 200,
          contentType: 'application/json',
          jsonSchema: endpoints[0].responses[0].schema,
          contractChecks: ['response matches documented schema']
        }
      }
    ];

    generateTestsMock.mockResolvedValueOnce({
      tests: [
        {
          endpointId: 'GET::/users/:id',
          category: 'positive',
          title: 'gets user after repair',
          request: {
            method: 'GET',
            path: '/users/1'
          },
          expected: {
            status: 200
          }
        }
      ]
    });

    const repaired = await repairTestsFromValidation({
      settings: baseSettings,
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints,
      tests: currentTests,
      validationSummary: {
        attempted: 1,
        passed: 0,
        failed: 1,
        repaired: 0,
        skipped: 0,
        lastValidatedAt: Date.now(),
        results: [
          {
            endpointId: 'GET::/users/:id',
            title: 'gets user by id',
            success: false,
            durationMs: 10,
            failures: [{ type: 'status', message: 'Expected HTTP 200 but received 500.' }]
          }
        ]
      }
    });

    expect(repaired[0].expected.contentType).toBe('application/json');
    expect(repaired[0].expected.jsonSchema).toBeDefined();
    expect(repaired[0].request.headers?.Authorization).toBe('Bearer {{API_TOKEN}}');
  });
});

describe('generateTestSuite heartbeat propagation', () => {
  const endpoint: ApiEndpoint = {
    id: 'GET::/ping',
    method: 'GET',
    path: '/ping',
    source: 'express',
    auth: 'none',
    pathParams: [],
    queryParams: [],
    responses: [{ status: '200' }]
  };

  const passingTests: GeneratedTestCase[] = [
    {
      endpointId: 'GET::/ping',
      category: 'positive',
      title: 'returns 200 for ping',
      request: { method: 'GET', path: '/ping' },
      expected: { status: 200 }
    },
    {
      endpointId: 'GET::/ping',
      category: 'negative',
      title: 'returns 400 for bad ping request',
      request: { method: 'GET', path: '/ping' },
      expected: { status: 400 }
    },
    {
      endpointId: 'GET::/ping',
      category: 'edge',
      title: 'handles edge case ping',
      request: { method: 'GET', path: '/ping' },
      expected: { status: 200 }
    },
    {
      endpointId: 'GET::/ping',
      category: 'security',
      title: 'unauthorized ping returns 401',
      request: { method: 'GET', path: '/ping' },
      expected: { status: 401 }
    }
  ];

  it('passes heartbeatMs: 30_000 to the provider adapter', async () => {
    generateTestsMock.mockResolvedValueOnce({ tests: passingTests });

    await generateTestSuite({
      settings: baseSettings,
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints: [endpoint]
    });

    expect(generateTestsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ heartbeatMs: 30_000 })
    );
  });

  it('invokes onBatchHeartbeat when the provider calls onHeartbeat', async () => {
    let capturedOnHeartbeat: ((elapsedMs: number) => Promise<void>) | undefined;

    generateTestsMock.mockImplementationOnce(async (_batch, _ctx, opts: ProviderOptions) => {
      capturedOnHeartbeat = opts.onHeartbeat as (elapsedMs: number) => Promise<void>;
      return { tests: passingTests };
    });

    const onBatchHeartbeat = vi.fn().mockResolvedValue(undefined);

    await generateTestSuite({
      settings: baseSettings,
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints: [endpoint],
      onBatchHeartbeat
    });

    expect(capturedOnHeartbeat).toBeDefined();
    await capturedOnHeartbeat!(5000);
    expect(onBatchHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 'generate', elapsedMs: 5000 })
    );
  });
});
