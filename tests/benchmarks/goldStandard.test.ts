import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseApiMap } from '@background/parser/apiParser';
import { buildCoverage } from '@background/generation/coverage';
import { validateGeneratedTestsAgainstBaseUrl } from '@background/generation/executionValidator';
import { assessReadiness } from '@background/generation/readiness';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { ExtensionSettings, GeneratedTestCase, RepoFile } from '@shared/types';
import { BENCHMARK_BASELINE } from './baseline';

interface BenchmarkFixture {
  name: string;
  files: RepoFile[];
  expectedEndpoints: string[];
  generatedTests: GeneratedTestCase[];
  settingsPatch?: Partial<ExtensionSettings>;
}

const fixtures: BenchmarkFixture[] = [
  {
    name: 'express-openapi-merge',
    files: [
      {
        path: 'src/routes/users.ts',
        content: `
          import { Router } from 'express';
          const router = Router();
          router.get('/users/:id', handler);
          router.get('/users', listUsers);
          export default router;
        `
      },
      {
        path: 'openapi.yaml',
        content: `
openapi: 3.0.0
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
paths:
  /users/{id}:
    get:
      security:
        - bearerAuth: []
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id:
                    type: integer
  /users:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: integer
`
      }
    ],
    expectedEndpoints: ['GET::/users/:id', 'GET::/users'],
    generatedTests: [
      {
        endpointId: 'GET::/users/:id',
        category: 'positive',
        title: 'gets user by id',
        request: { method: 'GET', path: '/users/1', headers: { Authorization: 'Bearer {{API_TOKEN}}' } },
        expected: {
          status: 200,
          contentType: 'application/json',
          jsonSchema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { name: 'id', required: true, type: 'integer' }
            }
          },
          contractChecks: ['response matches documented schema'],
          idempotent: true
        }
      }
    ],
    settingsPatch: {
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
    }
  },
  {
    name: 'nextjs-orders-route',
    files: [
      {
        path: 'app/api/orders/route.ts',
        content: `
          export async function GET() { return Response.json({ data: [{ id: 1 }], nextCursor: 'abc' }); }
          export async function POST() { return Response.json({ id: 1 }, { status: 201 }); }
        `
      }
    ],
    expectedEndpoints: ['GET::/api/orders', 'POST::/api/orders'],
    generatedTests: [
      {
        endpointId: 'GET::/api/orders',
        category: 'positive',
        title: 'lists orders with cursor pagination',
        request: { method: 'GET', path: '/api/orders', query: { cursor: 'abc' } },
        expected: {
          status: 200,
          contentType: 'application/json',
          contractChecks: ['pagination semantics preserved'],
          pagination: true
        }
      }
    ]
  },
  {
    name: 'fastify-pagination-auth',
    files: [
      {
        path: 'src/server.ts',
        content: `
          fastify.get('/reports', { preHandler: [authGuard] }, async () => ({ items: [{ id: 1 }], total: 1 }));
        `
      },
      {
        path: 'openapi.json',
        content: JSON.stringify({
          openapi: '3.0.0',
          components: {
            securitySchemes: {
              bearerAuth: { type: 'http', scheme: 'bearer' }
            }
          },
          paths: {
            '/reports': {
              get: {
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }],
                responses: {
                  200: {
                    description: 'ok',
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          required: ['items'],
                          properties: {
                            items: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  id: { type: 'integer' }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        })
      }
    ],
    expectedEndpoints: ['GET::/reports'],
    generatedTests: [
      {
        endpointId: 'GET::/reports',
        category: 'positive',
        title: 'lists reports with bearer auth',
        request: { method: 'GET', path: '/reports', query: { page: 1 }, headers: { Authorization: 'Bearer {{API_TOKEN}}' } },
        expected: {
          status: 200,
          contentType: 'application/json',
          jsonSchema: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { name: 'id', required: true, type: 'integer' }
                  }
                }
              }
            }
          },
          contractChecks: ['response matches documented schema', 'pagination semantics preserved'],
          pagination: true,
          idempotent: true
        }
      }
    ],
    settingsPatch: {
      runtimeAuthMode: 'bearer',
      runtimeApiToken: 'runtime-token'
    }
  },
  {
    name: 'spring-and-gin-detection',
    files: [
      {
        path: 'src/main/java/demo/UserController.java',
        content: `
          @RestController
          @RequestMapping("/api")
          class UserController {
            @GetMapping("/users/{id}")
            public User getUser() { return null; }
          }
        `
      },
      {
        path: 'server/routes.go',
        content: `
          router := gin.Default()
          v1 := router.Group("/v1")
          v1.POST("/orders", createOrder)
        `
      }
    ],
    expectedEndpoints: ['GET::/api/users/:id', 'POST::/v1/orders'],
    generatedTests: []
  }
];

const buildFetchStub = () => vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url.includes('/auth/login')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ token: 'runtime-token' })
    };
  }

  if (url.includes('/users/1')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ id: 1 })
    };
  }

  if (url.includes('/api/orders')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ data: [{ id: 1 }], nextCursor: 'abc' })
    };
  }

  if (url.includes('/reports')) {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ items: [{ id: 1 }], total: 1 })
    };
  }

  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({})
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gold-standard benchmark fixtures', () => {
  it('keeps endpoint recall above the baseline across the benchmark corpus', () => {
    let matchedEndpoints = 0;
    let expectedEndpoints = 0;

    for (const fixture of fixtures) {
      const parsed = parseApiMap(fixture.files);
      const parsedIds = new Set(parsed.map((endpoint) => endpoint.id));
      matchedEndpoints += fixture.expectedEndpoints.filter((endpointId) => parsedIds.has(endpointId)).length;
      expectedEndpoints += fixture.expectedEndpoints.length;
      expect(parsed.every((endpoint) => typeof endpoint.trustScore === 'number')).toBe(true);
    }

    const recall = matchedEndpoints / expectedEndpoints;
    expect(recall).toBeGreaterThanOrEqual(BENCHMARK_BASELINE.minRecall);
  });

  it('tracks validation, readiness, and manual-edit metrics against the baseline', async () => {
    vi.stubGlobal('fetch', buildFetchStub());

    const metrics = [];
    for (const fixture of fixtures) {
      const endpoints = parseApiMap(fixture.files);
      const coverage = buildCoverage(endpoints, fixture.generatedTests);
      const validation = await validateGeneratedTestsAgainstBaseUrl(
        {
          ...DEFAULT_SETTINGS,
          baseUrl: 'http://localhost:3000',
          ...fixture.settingsPatch
        },
        fixture.generatedTests,
        endpoints
      );
      const readiness = assessReadiness(fixture.generatedTests, validation);

      metrics.push({
        name: fixture.name,
        coverage: coverage.coveragePercent,
        attempted: validation.attempted,
        passRate: validation.attempted === 0 ? 1 : validation.passed / validation.attempted,
        manualEditsRequired: validation.failed + (validation.notRunReason ? 1 : 0),
        readiness: readiness.readiness
      });
    }

    const validatedFixtures = metrics.filter((metric) => ['validated', 'production_candidate'].includes(metric.readiness)).length;
    const aggregatePassRate = metrics.reduce((total, metric) => total + metric.passRate, 0) / metrics.length;
    const manualEdits = metrics.reduce((total, metric) => total + metric.manualEditsRequired, 0);

    expect(metrics[0].coverage).toBeGreaterThanOrEqual(50);
    expect(aggregatePassRate).toBeGreaterThanOrEqual(BENCHMARK_BASELINE.minPassRate);
    expect(manualEdits).toBeLessThanOrEqual(BENCHMARK_BASELINE.maxManualEdits);
    expect(validatedFixtures).toBeGreaterThanOrEqual(BENCHMARK_BASELINE.minValidatedFixtures);
  });
});
