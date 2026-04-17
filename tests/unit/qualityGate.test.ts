import { describe, expect, it } from 'vitest';
import {
  assessGeneratedTestQuality,
  assertionStrength,
  defaultAuthHeadersForEndpoint,
  endpointPathToRegex,
  hasPlaceholders,
  isCategoryApplicable,
  mergeSafeRepairs,
  normalizeGeneratedTests,
  titleIsGeneric
} from '@background/generation/qualityGate';
import { makeEndpoint, makeGeneratedTestCase } from '@shared/testing/factories';

// ---------------------------------------------------------------------------
// hasPlaceholders / endpointPathToRegex
// ---------------------------------------------------------------------------

describe('hasPlaceholders', () => {
  it('detects colon params', () => {
    expect(hasPlaceholders('/users/:id')).toBe(true);
    expect(hasPlaceholders('/users/42')).toBe(false);
  });

  it('detects brace params', () => {
    expect(hasPlaceholders('/orgs/{orgId}/repos')).toBe(true);
    expect(hasPlaceholders('/orgs/acme/repos')).toBe(false);
  });
});

describe('endpointPathToRegex', () => {
  it('matches concrete paths that satisfy the template', () => {
    const re = endpointPathToRegex('/users/:id');
    expect(re.test('/users/42')).toBe(true);
    expect(re.test('/users/abc-def')).toBe(true);
    expect(re.test('/users/')).toBe(false);
    expect(re.test('/accounts/42')).toBe(false);
  });

  it('handles wildcard colon params', () => {
    const re = endpointPathToRegex('/files/:path*');
    expect(re.test('/files/a/b/c')).toBe(true);
  });

  it('handles brace-style params', () => {
    const re = endpointPathToRegex('/v1/{tenant}/users/{userId}');
    expect(re.test('/v1/acme/users/123')).toBe(true);
    expect(re.test('/v1/acme/users/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// titleIsGeneric
// ---------------------------------------------------------------------------

describe('titleIsGeneric', () => {
  const ep = makeEndpoint({ id: 'GET::/items', method: 'GET', path: '/items' });

  it('flags known generic phrases', () => {
    expect(titleIsGeneric('api test', ep)).toBe(true);
    expect(titleIsGeneric('test case', ep)).toBe(true);
    expect(titleIsGeneric('generated test', ep)).toBe(true);
  });

  it('flags very short titles', () => {
    expect(titleIsGeneric('ok', ep)).toBe(true);
  });

  it('accepts descriptive titles', () => {
    expect(titleIsGeneric('GET /items returns paginated list of items when authenticated', ep)).toBe(false);
    expect(titleIsGeneric('returns 401 when authorization header is absent', ep)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCategoryApplicable
// ---------------------------------------------------------------------------

describe('isCategoryApplicable', () => {
  it('always allows non-security categories', () => {
    const ep = makeEndpoint({ auth: 'none', method: 'GET' });
    expect(isCategoryApplicable(ep, 'positive')).toBe(true);
    expect(isCategoryApplicable(ep, 'negative')).toBe(true);
  });

  it('disallows security on GET endpoints with no auth', () => {
    const ep = makeEndpoint({ auth: 'none', method: 'GET' });
    expect(isCategoryApplicable(ep, 'security')).toBe(false);
  });

  it('allows security when method is not GET even without auth', () => {
    const ep = makeEndpoint({ auth: 'none', method: 'DELETE' });
    expect(isCategoryApplicable(ep, 'security')).toBe(true);
  });

  it('allows security when endpoint has auth', () => {
    const ep = makeEndpoint({ auth: 'bearer', method: 'GET' });
    expect(isCategoryApplicable(ep, 'security')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultAuthHeadersForEndpoint
// ---------------------------------------------------------------------------

describe('defaultAuthHeadersForEndpoint', () => {
  it('adds Authorization header for bearer endpoints', () => {
    const ep = makeEndpoint({ auth: 'bearer', authHints: [] });
    const headers = defaultAuthHeadersForEndpoint(ep);
    expect(headers.Authorization).toBe('Bearer {{API_TOKEN}}');
  });

  it('uses authHint headerName when provided', () => {
    const ep = makeEndpoint({
      auth: 'apiKey',
      authHints: [{ headerName: 'X-Api-Key', type: 'apiKey' }]
    });
    const headers = defaultAuthHeadersForEndpoint(ep);
    expect(headers['X-Api-Key']).toBe('{{API_KEY}}');
  });

  it('returns empty object for none auth', () => {
    const ep = makeEndpoint({ auth: 'none', authHints: [] });
    const headers = defaultAuthHeadersForEndpoint(ep);
    expect(Object.keys(headers)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assertionStrength
// ---------------------------------------------------------------------------

describe('assertionStrength', () => {
  it('returns 0 for a bare test with no assertions', () => {
    const test = makeGeneratedTestCase({
      expected: { status: 200, contractChecks: [], contains: [] }
    });
    expect(assertionStrength(test)).toBe(0);
  });

  it('adds points for each assertion type', () => {
    const test = makeGeneratedTestCase({
      expected: {
        status: 200,
        contains: ['id'],
        contentType: 'application/json',
        contractChecks: ['schema matches', 'pagination preserved'],
        jsonSchema: { type: 'object' },
        pagination: true,
        idempotent: true
      }
    });
    const strength = assertionStrength(test);
    expect(strength).toBeGreaterThanOrEqual(9);
  });
});

// ---------------------------------------------------------------------------
// mergeSafeRepairs
// ---------------------------------------------------------------------------

describe('mergeSafeRepairs', () => {
  const ep = makeEndpoint({ id: 'POST::/items', method: 'POST', path: '/items' });

  it('keeps the repaired test when it is strictly better', () => {
    const original = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      title: 'POST /items creates item successfully',
      request: { method: 'POST', path: '/items' },
      expected: { status: 200, contractChecks: ['schema'] }
    });
    const repaired = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      title: 'POST /items creates item successfully',
      request: { method: 'POST', path: '/items' },
      expected: { status: 200, contractChecks: ['schema'], contentType: 'application/json' }
    });
    const result = mergeSafeRepairs([original], [repaired], [ep], []);
    expect(result[0]?.expected.contentType).toBe('application/json');
  });

  it('keeps the original when the repaired test is weaker', () => {
    const original = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      title: 'POST /items creates item successfully',
      request: { method: 'POST', path: '/items' },
      expected: { status: 200, contractChecks: ['schema', 'pagination'] }
    });
    const weaker = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      title: 'POST /items creates item successfully',
      request: { method: 'POST', path: '/items' },
      expected: { status: 200, contractChecks: [] }
    });
    const result = mergeSafeRepairs([original], [weaker], [ep], []);
    expect(result[0]?.expected.contractChecks).toHaveLength(2);
  });

  it('adds new tests that have no previous counterpart', () => {
    const existing = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      title: 'POST /items creates item',
      request: { method: 'POST', path: '/items' },
      expected: { status: 200 }
    });
    const newTest = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'negative',
      title: 'POST /items returns 400 for empty body',
      request: { method: 'POST', path: '/items' },
      expected: { status: 400 }
    });
    const result = mergeSafeRepairs([existing], [newTest], [ep], []);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// normalizeGeneratedTests
// ---------------------------------------------------------------------------

describe('normalizeGeneratedTests', () => {
  const ep = makeEndpoint({
    id: 'GET::/users',
    method: 'GET',
    path: '/users',
    auth: 'bearer',
    authHints: []
  });

  it('injects default auth header for bearer endpoints when absent', () => {
    const input = [{
      endpointId: 'GET::/users',
      category: 'positive',
      title: 'GET /users returns list',
      request: { method: 'GET', path: '/users', headers: {} },
      expected: { status: 200 }
    }];
    const result = normalizeGeneratedTests(input, ['positive'], [ep]);
    expect(result[0]?.request.headers?.Authorization).toBe('Bearer {{API_TOKEN}}');
  });

  it('does not overwrite existing auth header', () => {
    const input = [{
      endpointId: 'GET::/users',
      category: 'positive',
      title: 'GET /users returns list',
      request: { method: 'GET', path: '/users', headers: { Authorization: 'Bearer custom-token' } },
      expected: { status: 200 }
    }];
    const result = normalizeGeneratedTests(input, ['positive'], [ep]);
    expect(result[0]?.request.headers?.Authorization).toBe('Bearer custom-token');
  });
});

// ---------------------------------------------------------------------------
// assessGeneratedTestQuality — comprehensive
// ---------------------------------------------------------------------------

describe('assessGeneratedTestQuality — comprehensive', () => {
  const ep = makeEndpoint({
    id: 'DELETE::/users/:id',
    method: 'DELETE',
    path: '/users/:id',
    auth: 'bearer',
    responses: [{ status: '204', description: 'Deleted' }, { status: '404', description: 'Not found' }]
  });

  it('flags unresolved path params when all paths still have placeholders', () => {
    const test = makeGeneratedTestCase({
      endpointId: 'DELETE::/users/:id',
      category: 'positive',
      title: 'DELETE /users/:id removes the user from the system',
      request: { method: 'DELETE', path: '/users/:id' },
      expected: { status: 204 }
    });
    const result = assessGeneratedTestQuality([ep], [test], ['positive']);
    const issue = result.issues.find((i) => i.code === 'unresolved-path');
    expect(issue).toBeDefined();
  });

  it('does not flag unresolved-path when a concrete path is provided', () => {
    const test = makeGeneratedTestCase({
      endpointId: 'DELETE::/users/:id',
      category: 'positive',
      title: 'DELETE /users/42 removes user 42 from the system',
      request: { method: 'DELETE', path: '/users/42' },
      expected: { status: 204 }
    });
    const result = assessGeneratedTestQuality([ep], [test], ['positive']);
    expect(result.issues.find((i) => i.code === 'unresolved-path')).toBeUndefined();
  });

  it('reports passed=false when there are error-level issues', () => {
    const result = assessGeneratedTestQuality([ep], [], ['positive']);
    expect(result.passed).toBe(false);
  });

  it('passes when all error issues are resolved even if warnings remain', () => {
    const tests = [
      makeGeneratedTestCase({
        endpointId: 'DELETE::/users/:id',
        category: 'positive',
        title: 'DELETE /users/42 removes the user and returns 204',
        request: { method: 'DELETE', path: '/users/42' },
        expected: { status: 204 }
      }),
      makeGeneratedTestCase({
        endpointId: 'DELETE::/users/:id',
        category: 'security',
        title: 'DELETE /users/42 returns 401 when no authorization header is present',
        request: { method: 'DELETE', path: '/users/42', headers: {} },
        expected: { status: 401 }
      })
    ];
    const result = assessGeneratedTestQuality([ep], tests, ['positive', 'security']);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});
