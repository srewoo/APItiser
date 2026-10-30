// @vitest-environment node
/**
 * Real end-to-end execution of the validation engine: a live Node HTTP server + the actual
 * `validateGeneratedTestsAgainstBaseUrl` firing REAL fetch requests (no mocks). Proves that a
 * generated suite is genuinely executed against a running API and that pass/fail is decided by
 * the real responses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { validateGeneratedTestsAgainstBaseUrl } from '@background/generation/executionValidator';
import { makeSettings, makeEndpoint, makeGeneratedTestCase } from '@shared/testing/factories';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/widgets') return send(200, { widgets: [{ id: '1' }] });
    if (req.method === 'POST' && url.pathname === '/widgets') return send(201, { id: 'w-42', name: 'gadget' });
    if (req.method === 'GET' && /^\/widgets\/[^/]+$/.test(url.pathname)) {
      return url.pathname.endsWith('/missing') ? send(404, { error: 'not found' }) : send(200, { id: '1' });
    }
    return send(404, { error: 'no route' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('live validation against a real HTTP server', () => {
  it('executes the generated suite and decides pass/fail from real responses', async () => {
    const settings = makeSettings({
      baseUrl,
      runtimeAuthMode: 'none',
      validateGeneratedTests: true,
      retryOnRateLimit: false
    });

    const endpoints = [
      makeEndpoint({ id: 'GET::/health', method: 'GET', path: '/health' }),
      makeEndpoint({ id: 'GET::/widgets', method: 'GET', path: '/widgets' }),
      makeEndpoint({ id: 'POST::/widgets', method: 'POST', path: '/widgets' }),
      makeEndpoint({ id: 'GET::/widgets/:id', method: 'GET', path: '/widgets/:id' })
    ];

    const tests = [
      // Passes: real 200 with the asserted field.
      makeGeneratedTestCase({
        endpointId: 'GET::/health',
        title: 'GET /health → 200',
        request: { method: 'GET', path: '/health' },
        expected: { status: 200, bodyAssertions: [{ path: 'status', op: 'equals', value: 'ok' }] }
      }),
      // Passes: real 201 on create.
      makeGeneratedTestCase({
        endpointId: 'POST::/widgets',
        category: 'positive',
        title: 'POST /widgets → 201',
        request: { method: 'POST', path: '/widgets', body: { name: 'gadget' } },
        expected: { status: 201, bodyAssertions: [{ path: 'id', op: 'exists' }] }
      }),
      // Passes: real 404 for a missing resource (negative case).
      makeGeneratedTestCase({
        endpointId: 'GET::/widgets/:id',
        category: 'negative',
        title: 'GET /widgets/missing → 404',
        request: { method: 'GET', path: '/widgets/missing' },
        expected: { status: 404 }
      }),
      // FAILS on purpose: server returns 200, test expects 500 — proves execution discriminates.
      makeGeneratedTestCase({
        endpointId: 'GET::/widgets',
        category: 'positive',
        title: 'GET /widgets → (wrongly) 500',
        request: { method: 'GET', path: '/widgets' },
        expected: { status: 500 }
      })
    ];

    const summary = await validateGeneratedTestsAgainstBaseUrl(settings, tests, endpoints);

    // The engine actually ran every test against the live server.
    expect(summary.notRunReason).toBeUndefined();
    expect(summary.attempted).toBe(4);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(1);

    // The failing case is the 500-expectation, keyed to the right test.
    const failing = summary.results.filter((r) => !r.success);
    expect(failing).toHaveLength(1);
    expect(failing[0].title).toContain('500');

    // Each result carries the real observed status from the server.
    const health = summary.results.find((r) => r.title.includes('/health'));
    expect(health?.status).toBe(200);
  });
});
