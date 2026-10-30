import { describe, expect, it } from 'vitest';
import { hasRepairableFailures, markMissingRoutes, triageFailure } from '@background/generation/failureTriage';
import { makeEndpoint, makeGeneratedTestCase, makeValidationResult, makeValidationSummary } from '@shared/testing/factories';
import type { TestCategory, ValidationFailure } from '@shared/types';

const fail = (status: number | undefined, type: ValidationFailure['type'] = 'status') =>
  makeValidationResult({ success: false, status, failures: [{ type, message: 'x' }] });
const test = (category: TestCategory, status = 200) => makeGeneratedTestCase({ category, expected: { status } });

describe('triageFailure', () => {
  it.each([
    ['5xx on a happy path', fail(500), test('positive'), 'api'],
    ['5xx on a negative test', fail(503), test('negative', 400), 'api'],
    ['security test accepted (auth bypass)', fail(200, 'auth'), test('security', 401), 'api'],
    ['negative test accepted (missing validation)', fail(201), test('negative', 400), 'api'],
    ['edge test accepted', fail(200), test('edge', 422), 'api'],
    ['documented contract broken', fail(200, 'contract'), test('positive'), 'api'],
    ['idempotency broken', fail(200, 'idempotency'), test('positive'), 'api'],
    ['credentials refused', fail(401), test('positive'), 'test'],
    ['bad payload / unknown id', fail(404), test('positive'), 'test'],
    ['wrong expected 4xx', fail(422), test('negative', 400), 'test'],
    ['body assertion mismatch on a 200', fail(200, 'contains'), test('positive'), 'test']
  ])('%s → %s', (_name, result, testCase, verdict) => {
    expect(triageFailure(result, testCase)?.verdict).toBe(verdict);
  });

  it('has no verdict for passes or connection failures', () => {
    expect(triageFailure(makeValidationResult(), test('positive'))).toBeUndefined();
    expect(triageFailure(fail(undefined, 'network'), test('positive'))).toBeUndefined();
  });

  it('only counts test-side failures as repairable', () => {
    const apiBug = { ...fail(500), verdict: 'api' as const };
    const testBug = { ...fail(404), verdict: 'test' as const };
    expect(hasRepairableFailures(makeValidationSummary({ results: [apiBug] }))).toBe(false);
    expect(hasRepairableFailures(makeValidationSummary({ results: [apiBug, testBug] }))).toBe(true);
  });
});

describe('markMissingRoutes', () => {
  const admin = makeEndpoint({ id: 'GET::/admin', method: 'GET', path: '/admin' });
  const user = makeEndpoint({ id: 'GET::/users/{id}', method: 'GET', path: '/users/{id}' });
  const r404 = (endpointId: string, title: string) =>
    makeValidationResult({ endpointId, title, success: false, status: 404, verdict: 'test', failures: [{ type: 'status', message: 'x' }] });

  it('marks a parameter-free endpoint whose every request 404s as a missing route', () => {
    const out = markMissingRoutes([r404(admin.id, 'a'), r404(admin.id, 'b')], [admin]);
    expect(out.map((r) => r.verdict)).toEqual(['missing', 'missing']);
    expect(out[0].verdictReason).toContain('GET /admin returned 404 — the API has no such route');
    expect(hasRepairableFailures(makeValidationSummary({ results: out }))).toBe(false);
  });

  it('leaves it alone if any request got a real answer, or if 404 can mean an unknown id', () => {
    const mixed = [r404(admin.id, 'a'), makeValidationResult({ endpointId: admin.id, title: 'b', status: 401, success: false })];
    expect(markMissingRoutes(mixed, [admin])[0].verdict).toBe('test');
    expect(markMissingRoutes([r404(user.id, 'a')], [user])[0].verdict).toBe('test');
  });
});
