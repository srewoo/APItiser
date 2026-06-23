import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessGeneratedTestQuality,
  generateTestSuite,
  normalizeGeneratedTests,
  repairTestsFromValidation
} from '@background/generation/testGenerator';
import type {
  ApiEndpoint,
  ExtensionSettings,
  GeneratedTestCase,
  GenerateContext,
  ProviderOptions
} from '@shared/types';

const generateTestsMock =
  vi.fn<
    (
      batch: ApiEndpoint[],
      context: GenerateContext,
      options: ProviderOptions
    ) => Promise<{ tests: GeneratedTestCase[] }>
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

    // The job should succeed but the diagnostics should show that it failed the assessment.
    // (The suite also includes deterministic security cases for this authenticated /:id
    // endpoint, so we assert on the model-origin test rather than the exact total.)
    expect(result.tests.some((test) => test.title === 'still generic')).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].assessment.passed).toBe(false);
  });

  it('backfills endpoints the main pass left uncovered (coverage-completion pass)', async () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users',
        method: 'GET',
        path: '/users',
        source: 'openapi',
        auth: 'none',
        pathParams: [],
        queryParams: [],
        responses: [{ status: '200' }]
      }
    ];

    const validTest: GeneratedTestCase = {
      endpointId: 'GET::/users',
      category: 'positive',
      title: 'lists users successfully',
      request: { method: 'GET', path: '/users' },
      expected: { status: 200 }
    };

    // Main pass: generate + 3 repair attempts all come back empty (simulating a truncated
    // batch). The coverage-completion pass then re-requests the endpoint and succeeds.
    generateTestsMock
      .mockResolvedValueOnce({ tests: [] })
      .mockResolvedValueOnce({ tests: [] })
      .mockResolvedValueOnce({ tests: [] })
      .mockResolvedValueOnce({ tests: [] })
      .mockResolvedValue({ tests: [validTest] });

    const result = await generateTestSuite({
      settings: { ...baseSettings, includeCategories: ['positive'] },
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints
    });

    // The endpoint that the main pass missed is covered after backfill, and the overall
    // assessment passes — no lingering "Missing all tests" error.
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].endpointId).toBe('GET::/users');
    expect(result.finalAssessment.passed).toBe(true);
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

    // All four repaired model tests must be present (the suite is additionally augmented
    // with deterministic schema/security cases, so the total exceeds four).
    const titles = result.tests.map((test) => test.title);
    for (const expectedTitle of [
      'creates user with valid email',
      'rejects missing email on create user',
      'handles long email input on create user',
      'rejects unauthorized create user request'
    ]) {
      expect(titles).toContain(expectedTitle);
    }
    expect(result.diagnostics[0]?.repairAttempted).toBe(true);
    expect(result.diagnostics[0]?.assessment.passed).toBe(true);
    expect(onBatchComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        batchDiagnostics: expect.objectContaining({
          repairAttempted: true
        })
      })
    );
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
    expect(onBatchHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ attempt: 'generate', phase: 'generate', elapsedMs: 5000 }));
  });

  it('reports phase "backfill" on heartbeats during the coverage-completion pass', async () => {
    const ep: ApiEndpoint = {
      id: 'GET::/users',
      method: 'GET',
      path: '/users',
      source: 'openapi',
      auth: 'none',
      pathParams: [],
      queryParams: [],
      responses: [{ status: '200' }]
    };
    const validTest: GeneratedTestCase = {
      endpointId: 'GET::/users',
      category: 'positive',
      title: 'lists users successfully',
      request: { method: 'GET', path: '/users' },
      expected: { status: 200 }
    };

    let calls = 0;
    let backfillOnHeartbeat: ((elapsedMs: number) => Promise<void>) | undefined;
    // Main pass (generate + 3 repairs) returns nothing; the backfill call succeeds and is
    // where we capture the provider heartbeat.
    generateTestsMock.mockImplementation(async (_batch, _ctx, opts: ProviderOptions) => {
      calls += 1;
      if (calls <= 4) {
        return { tests: [] };
      }
      backfillOnHeartbeat = opts.onHeartbeat as (elapsedMs: number) => Promise<void>;
      return { tests: [validTest] };
    });

    const onBatchHeartbeat = vi.fn().mockResolvedValue(undefined);

    await generateTestSuite({
      settings: { ...baseSettings, includeCategories: ['positive'] },
      repo: { platform: 'github', owner: 'acme', repo: 'demo' },
      endpoints: [ep],
      onBatchHeartbeat
    });

    expect(backfillOnHeartbeat).toBeDefined();
    await backfillOnHeartbeat!(3000);
    // The backfill heartbeat must report phase 'backfill' so the UI shows a coverage
    // message instead of a nonsensical "N/total" counter (e.g. "16/12").
    expect(onBatchHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ phase: 'backfill', elapsedMs: 3000 }));
  });
});
