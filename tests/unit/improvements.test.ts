import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthesizeDeterministicCases } from '@background/generation/syntheticCases';
import { synthesizeSecurityCases, INJECTION_PAYLOADS } from '@background/generation/securityCases';
import { orderTestsByLifecycle } from '@background/generation/resourceLifecycle';
import { consolidateAuth } from '@background/parser/authConsolidation';
import { normalizeGeneratedTests, assessGeneratedTestQuality, assertionStrength } from '@background/generation/qualityGate';
import { identityHeaders, jsHeaderValueExpr } from '@background/generation/frameworks/runtimeTokens';
import { renderBodyAssertionsJs, renderBodyAssertionsPy, jsRuntimeHelpers } from '@background/generation/frameworks/assertions';
import { JestFrameworkAdapter } from '@background/generation/frameworks/jest';
import { PytestFrameworkAdapter } from '@background/generation/frameworks/pytest';
import { validateGeneratedTestsAgainstBaseUrl } from '@background/generation/executionValidator';
import { DEFAULT_SETTINGS } from '@shared/constants';
import { makeEndpoint, makeGeneratedTestCase } from '@shared/testing/factories';
import type { ApiEndpoint, GeneratedTestCase, ProjectMeta, SchemaObject } from '@shared/types';

const bodySchema: SchemaObject = {
  type: 'object',
  required: ['email', 'role'],
  properties: {
    email: { name: 'email', required: true, type: 'string', format: 'email', maxLength: 50 },
    role: { name: 'role', required: true, type: 'string', enum: ['admin', 'user'] },
    age: { name: 'age', required: false, type: 'integer', minimum: 0, maximum: 120 }
  }
};

const projectMeta: ProjectMeta = {
  repo: { platform: 'github', owner: 'acme', repo: 'demo' },
  generatedAt: '2026-01-01T00:00:00Z',
  framework: 'jest',
  endpointCount: 1
};

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// #2 Schema-driven negative/edge synthesis
// ---------------------------------------------------------------------------
describe('synthesizeDeterministicCases (#2)', () => {
  const endpoint = makeEndpoint({ id: 'POST::/users', method: 'POST', path: '/users', body: bodySchema });

  it('omits each required field as a negative case', () => {
    const cases = synthesizeDeterministicCases(endpoint, ['negative']);
    expect(cases.some((c) => c.title.includes('required field "email" is missing'))).toBe(true);
    expect(cases.some((c) => c.title.includes('required field "role" is missing'))).toBe(true);
    expect(cases.every((c) => c.category === 'negative')).toBe(true);
    expect(cases.every((c) => c.expected.status >= 400)).toBe(true);
  });

  it('generates wrong-type and enum-violation negatives', () => {
    const cases = synthesizeDeterministicCases(endpoint, ['negative']);
    expect(cases.some((c) => c.title.includes('"age" has the wrong type'))).toBe(true);
    expect(cases.some((c) => c.title.includes('"role" is outside its allowed values'))).toBe(true);
    const ageCase = cases.find((c) => c.title.includes('"age" has the wrong type'));
    expect((ageCase?.request.body as Record<string, unknown>).age).toBe('not-a-number');
  });

  it('generates boundary edge cases honoring the endpoint success status', () => {
    const edges = synthesizeDeterministicCases(endpoint, ['edge']);
    expect(edges.some((c) => c.title.includes('maximum length'))).toBe(true);
    expect(edges.some((c) => c.title.includes('maximum value'))).toBe(true);
    // Boundary edge cases use the endpoint's documented success status (a 2xx), never a 4xx.
    expect(edges.filter((c) => c.title.includes('maximum')).every((c) => c.expected.status >= 200 && c.expected.status < 300)).toBe(true);
  });

  it('returns nothing for endpoints without a body schema', () => {
    const bare = makeEndpoint({ id: 'GET::/ping', method: 'GET', path: '/ping' });
    expect(synthesizeDeterministicCases(bare, ['negative', 'edge'])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #5 Security synthesis (auth-absence, IDOR, injection)
// ---------------------------------------------------------------------------
describe('synthesizeSecurityCases (#5)', () => {
  const authedItem = makeEndpoint({ id: 'GET::/users/:id', method: 'GET', path: '/users/:id', auth: 'bearer', pathParams: [{ name: 'id', required: true, type: 'integer' }] });

  it('creates an unauthenticated-access case for an authed endpoint', () => {
    const cases = synthesizeSecurityCases(authedItem, ['security'], { hasSecondaryIdentity: false });
    const authAbsence = cases.find((c) => c.title.includes('unauthenticated'));
    expect(authAbsence?.request.identity).toBe('none');
    expect(authAbsence?.expected.status).toBeGreaterThanOrEqual(400);
  });

  it('uses the secondary identity for IDOR when available', () => {
    const withSecondary = synthesizeSecurityCases(authedItem, ['security'], { hasSecondaryIdentity: true });
    const idor = withSecondary.find((c) => c.title.startsWith('IDOR'));
    expect(idor?.request.identity).toBe('secondary');

    const withoutSecondary = synthesizeSecurityCases(authedItem, ['security'], { hasSecondaryIdentity: false });
    const fallback = withoutSecondary.find((c) => c.title.includes('without the owning identity'));
    expect(fallback?.request.identity).toBe('none');
  });

  it('emits injection negatives for string body fields', () => {
    const endpoint = makeEndpoint({ id: 'POST::/users', method: 'POST', path: '/users', body: bodySchema });
    const cases = synthesizeSecurityCases(endpoint, ['negative'], { hasSecondaryIdentity: false });
    for (const payload of INJECTION_PAYLOADS) {
      expect(cases.some((c) => c.title.includes(payload.label))).toBe(true);
    }
    expect(cases.every((c) => c.category === 'negative')).toBe(true);
  });

  it('does NOT emit injection negatives for body-less methods (GET with a documented body)', () => {
    const getWithBody = makeEndpoint({ id: 'GET::/search', method: 'GET', path: '/search', body: bodySchema });
    const cases = synthesizeSecurityCases(getWithBody, ['negative'], { hasSecondaryIdentity: false });
    expect(cases.some((c) => c.title.includes('payload'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #4 Resource lifecycle ordering
// ---------------------------------------------------------------------------
describe('orderTestsByLifecycle (#4)', () => {
  it('orders create before generic before delete and marks setup/teardown', () => {
    const create = makeGeneratedTestCase({ category: 'positive', request: { method: 'POST', path: '/users', headers: {} } });
    const read = makeGeneratedTestCase({ category: 'positive', request: { method: 'GET', path: '/users/1', headers: {} } });
    const remove = makeGeneratedTestCase({ category: 'positive', request: { method: 'DELETE', path: '/users/{id}', headers: {} } });

    const ordered = orderTestsByLifecycle([remove, read, create]);
    expect(ordered[0].request.method).toBe('POST');
    expect(ordered[0].isSetup).toBe(true);
    expect(ordered[ordered.length - 1].request.method).toBe('DELETE');
    expect(ordered[ordered.length - 1].isTeardown).toBe(true);
  });

  it('does not treat negative POSTs as setup', () => {
    const negativeCreate = makeGeneratedTestCase({ category: 'negative', request: { method: 'POST', path: '/users', headers: {} } });
    const [result] = orderTestsByLifecycle([negativeCreate]);
    expect(result.isSetup).toBeUndefined();
  });

  it('treats a non-terminal id-segment DELETE as teardown (runs last)', () => {
    const read = makeGeneratedTestCase({ category: 'positive', request: { method: 'GET', path: '/users/1', headers: {} } });
    const nestedDelete = makeGeneratedTestCase({ category: 'positive', request: { method: 'DELETE', path: '/users/{id}/sessions', headers: {} } });
    const ordered = orderTestsByLifecycle([nestedDelete, read]);
    expect(ordered[ordered.length - 1].request.path).toBe('/users/{id}/sessions');
    expect(ordered[ordered.length - 1].isTeardown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #9 Repo-level auth consolidation
// ---------------------------------------------------------------------------
describe('consolidateAuth (#9)', () => {
  it('snaps weakly-detected endpoints to the dominant scheme but preserves public and strongly-evidenced ones', () => {
    const endpoints: ApiEndpoint[] = [
      makeEndpoint({ id: 'a', auth: 'bearer' }),
      makeEndpoint({ id: 'b', auth: 'bearer' }),
      makeEndpoint({ id: 'c', auth: 'cookieSession' }), // weakly different → snap to bearer
      makeEndpoint({ id: 'd', auth: 'none' }), // public → preserved
      makeEndpoint({ id: 'e', auth: 'apiKey', authHints: [{ type: 'apiKey', confidence: 0.95 }] }) // strong → preserved
    ];
    const result = consolidateAuth(endpoints);
    expect(result.dominantScheme).toBe('bearer');
    expect(result.endpoints.find((e) => e.id === 'c')?.auth).toBe('bearer');
    expect(result.endpoints.find((e) => e.id === 'd')?.auth).toBe('none');
    expect(result.endpoints.find((e) => e.id === 'e')?.auth).toBe('apiKey');
    expect(result.changed).toBe(1);
  });

  it('is a no-op when no concrete scheme exists', () => {
    const endpoints = [makeEndpoint({ id: 'x', auth: 'none' }), makeEndpoint({ id: 'y', auth: 'unknown' })];
    expect(consolidateAuth(endpoints).changed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #6 Honest gate + #8 trust + executable body-assertion synthesis
// ---------------------------------------------------------------------------
describe('quality gate honesty and trust (#6, #8)', () => {
  const documentedEndpoint = makeEndpoint({
    id: 'GET::/users/:id',
    method: 'GET',
    path: '/users/:id',
    pathParams: [{ name: 'id', required: true, type: 'integer' }],
    responses: [{ status: '200', schema: { type: 'object', required: ['id', 'email'], properties: {} } }]
  });

  it('synthesizes executable body assertions from the documented schema', () => {
    const [normalized] = normalizeGeneratedTests(
      [{ endpointId: documentedEndpoint.id, category: 'positive', title: 'gets a user by id', request: { method: 'GET', path: '/users/1' }, expected: { status: 200 } }],
      ['positive'],
      [documentedEndpoint]
    );
    const paths = (normalized.expected.bodyAssertions ?? []).map((a) => a.path);
    expect(paths).toContain('id');
    expect(paths).toContain('email');
  });

  it('flags a status-only positive test as weak (free-text contractChecks do not count)', () => {
    const bare = makeEndpoint({ id: 'GET::/ping', method: 'GET', path: '/ping', responses: [{ status: '200' }] });
    const statusOnly = makeGeneratedTestCase({
      endpointId: bare.id,
      category: 'positive',
      request: { method: 'GET', path: '/ping', headers: {} },
      expected: { status: 200, contains: [], contractChecks: ['looks fine'], bodyAssertions: [] }
    });
    const assessment = assessGeneratedTestQuality([bare], [statusOnly], ['positive']);
    expect(assessment.issues.some((i) => i.code === 'weak-assertions')).toBe(true);
  });

  it('scores an asserted test as higher trust than a status-only one', () => {
    const base = { endpointId: documentedEndpoint.id, category: 'positive' as const, title: 'gets a user by id', request: { method: 'GET', path: '/users/1' } };
    const [asserted] = normalizeGeneratedTests([{ ...base, expected: { status: 200, bodyAssertions: [{ path: 'id', op: 'exists' }, { path: 'email', op: 'type', value: 'string' }] } }], ['positive'], [documentedEndpoint]);
    const statusOnlyEndpoint = makeEndpoint({ id: 'GET::/x', method: 'GET', path: '/x', confidence: 0.5, responses: [{ status: '200' }] });
    const [statusOnly] = normalizeGeneratedTests([{ endpointId: statusOnlyEndpoint.id, category: 'positive', title: 'x', request: { method: 'GET', path: '/x' }, expected: { status: 200 } }], ['positive'], [statusOnlyEndpoint]);
    expect(asserted.trustScore ?? 0).toBeGreaterThan(statusOnly.trustScore ?? 0);
  });

  it('does not count free-text contractChecks in assertionStrength', () => {
    const onlyNotes = makeGeneratedTestCase({ expected: { status: 200, contains: [], contractChecks: ['a', 'b', 'c'], bodyAssertions: [] } });
    expect(assertionStrength(onlyNotes)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1/#3 Executable assertion rendering + identity headers
// ---------------------------------------------------------------------------
describe('assertion rendering & identity (#1, #3, #5)', () => {
  it('renders executable JS body assertions via getByPath', () => {
    const test = makeGeneratedTestCase({ expected: { status: 200, bodyAssertions: [{ path: 'data.id', op: 'equals', value: 1 }] } });
    const out = renderBodyAssertionsJs(test, 'body', '  ', 'jest');
    expect(out).toContain('getByPath(body, "data.id")');
    expect(out).toContain('toEqual(1)');
  });

  it('guards the `in` op against a non-array value (no throwing matcher)', () => {
    const test = makeGeneratedTestCase({ expected: { status: 200, bodyAssertions: [{ path: 'role', op: 'in', value: 'admin' }] } });
    const out = renderBodyAssertionsJs(test, 'body', '  ', 'jest');
    expect(out).toContain('Array.isArray(');
    expect(out).toContain('toContainEqual');
  });

  it('renders executable Python body assertions', () => {
    const test = makeGeneratedTestCase({ expected: { status: 200, bodyAssertions: [{ path: 'id', op: 'exists' }] } });
    const out = renderBodyAssertionsPy(test, 'body', '    ');
    expect(out).toContain('get_by_path(body, "id") is not None');
  });

  it('JS schema helper honors enum and pattern', () => {
    const helpers = jsRuntimeHelpers('jest');
    expect(helpers).toContain('schema.enum');
    expect(helpers).toContain('schema.pattern');
    expect(helpers).toContain('fetchWithRetry');
    expect(helpers).toContain('assertIdempotent');
  });

  it('identityHeaders strips auth for none and injects secondary token', () => {
    const noneTest = makeGeneratedTestCase({ request: { method: 'GET', path: '/x', headers: { Authorization: 'Bearer {{API_TOKEN}}', 'X-Trace': 'keep' }, identity: 'none' } });
    const noneHeaders = identityHeaders(noneTest);
    expect(noneHeaders.Authorization).toBeUndefined();
    expect(noneHeaders['X-Trace']).toBe('keep');

    const secondary = makeGeneratedTestCase({ request: { method: 'GET', path: '/x', headers: {}, identity: 'secondary' } });
    expect(identityHeaders(secondary).Authorization).toBe('Bearer {{API_TOKEN_SECONDARY}}');
  });

  it('jsHeaderValueExpr env-backs arbitrary placeholders', () => {
    expect(jsHeaderValueExpr('Bearer {{API_TOKEN_SECONDARY}}')).toContain('process.env.API_TOKEN_SECONDARY');
    expect(jsHeaderValueExpr('static')).toBe('"static"');
  });
});

// ---------------------------------------------------------------------------
// #1/#7 Renderer integration: retry, idempotency oracle, executable schema
// ---------------------------------------------------------------------------
describe('renderer integration (#1, #7)', () => {
  const idempotentTest = makeGeneratedTestCase({
    endpointId: 'GET::/users/:id',
    category: 'positive',
    title: 'gets a user',
    request: { method: 'GET', path: '/users/1', headers: {} },
    expected: { status: 200, idempotent: true, jsonSchema: { type: 'object' }, bodyAssertions: [{ path: 'id', op: 'exists' }] }
  });

  it('jest emits retrying fetch, the idempotency oracle, and executable assertions', () => {
    const content = new JestFrameworkAdapter().render([idempotentTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('fetchWithRetry');
    expect(content).toContain('assertIdempotent(');
    expect(content).not.toContain('expect(repeat.status).toBeLessThan(500)');
    expect(content).toContain('getByPath(body, "id")');
  });

  it('pytest emits request_with_retry and assert_idempotent', () => {
    const content = new PytestFrameworkAdapter().render([idempotentTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('request_with_retry');
    expect(content).toContain('assert_idempotent(response, repeat)');
    expect(content).not.toContain('assert repeat.status_code < 500');
  });
});

// ---------------------------------------------------------------------------
// #3/#7 Validator: deep schema constraints, body assertions, idempotency, retry
// ---------------------------------------------------------------------------
describe('validator executable checks (#3, #7)', () => {
  const endpoint = makeEndpoint({ id: 'GET::/x', method: 'GET', path: '/x', responses: [{ status: '200' }] });
  const settings = { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:3000', runtimeAuthMode: 'none' as const };

  const mkResponse = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({
    ok: status < 400,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    json: async () => body
  });

  it('fails when a body assertion is violated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse(200, { id: 2 })));
    const tests: GeneratedTestCase[] = [
      makeGeneratedTestCase({ endpointId: endpoint.id, category: 'positive', request: { method: 'GET', path: '/x', headers: {} }, expected: { status: 200, bodyAssertions: [{ path: 'id', op: 'equals', value: 1 }] } })
    ];
    const summary = await validateGeneratedTestsAgainstBaseUrl(settings, tests, [endpoint]);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].failures.some((f) => f.type === 'contract')).toBe(true);
  });

  it('enforces enum constraints in schema validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse(200, { role: 'superadmin' })));
    const schema: SchemaObject = { type: 'object', properties: { role: { name: 'role', required: true, type: 'string', enum: ['admin', 'user'] } } };
    const tests: GeneratedTestCase[] = [
      makeGeneratedTestCase({ endpointId: endpoint.id, category: 'positive', request: { method: 'GET', path: '/x', headers: {} }, expected: { status: 200, jsonSchema: schema } })
    ];
    const summary = await validateGeneratedTestsAgainstBaseUrl(settings, tests, [endpoint]);
    expect(summary.results[0].failures.some((f) => f.type === 'schema')).toBe(true);
  });

  it('fails idempotency when the repeat body differs (ignoring volatile fields)', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return mkResponse(200, { id: call, updatedAt: `t${call}` });
    }));
    const tests: GeneratedTestCase[] = [
      makeGeneratedTestCase({ endpointId: endpoint.id, category: 'positive', request: { method: 'GET', path: '/x', headers: {} }, expected: { status: 200, idempotent: true } })
    ];
    const summary = await validateGeneratedTestsAgainstBaseUrl(settings, tests, [endpoint]);
    // id changes between calls → idempotency failure; updatedAt alone would have been ignored.
    expect(summary.results[0].failures.some((f) => f.type === 'idempotency')).toBe(true);
  });

  it('retries a transient 429 then succeeds', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1 ? mkResponse(429, { error: 'slow down' }) : mkResponse(200, { ok: true });
    }));
    const tests: GeneratedTestCase[] = [
      makeGeneratedTestCase({ endpointId: endpoint.id, category: 'positive', request: { method: 'GET', path: '/x', headers: {} }, expected: { status: 200 } })
    ];
    const summary = await validateGeneratedTestsAgainstBaseUrl({ ...settings, retryOnRateLimit: true, maxRetries: 2 }, tests, [endpoint]);
    expect(summary.passed).toBe(1);
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
