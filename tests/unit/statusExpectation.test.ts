import { describe, expect, it } from 'vitest';
import {
  statusExpectation,
  statusSatisfied,
  statusExpectationLabel,
  renderStatusAssertionJs,
  renderStatusAssertionChai,
  renderStatusAssertionPy,
  renderStatusAssertionGo,
  renderStatusAssertionJava
} from '@background/generation/statusExpectation';
import type { GeneratedTestCase } from '@shared/types';

const makeTest = (category: GeneratedTestCase['category'], status: number): GeneratedTestCase => ({
  endpointId: 'GET::/users',
  category,
  title: `${category} test`,
  request: { method: 'GET', path: '/users' },
  expected: { status }
});

describe('statusExpectation', () => {
  it('asserts an exact code for positive tests', () => {
    const expectation = statusExpectation(makeTest('positive', 200));
    expect(expectation).toEqual({ kind: 'exact', code: 200 });
    expect(statusExpectationLabel(makeTest('positive', 200))).toBe('200');
  });

  it('asserts the 4xx class for negative and security tests regardless of the guessed code', () => {
    for (const category of ['negative', 'security'] as const) {
      const expectation = statusExpectation(makeTest(category, 400));
      expect(expectation).toEqual({ kind: 'class', min: 400, max: 499 });
    }
  });

  it('asserts the matching class for edge tests based on the declared status', () => {
    expect(statusExpectation(makeTest('edge', 422))).toEqual({ kind: 'class', min: 400, max: 499 });
    expect(statusExpectation(makeTest('edge', 200))).toEqual({ kind: 'class', min: 200, max: 299 });
  });

  describe('statusSatisfied', () => {
    it('requires the exact code for positive tests', () => {
      expect(statusSatisfied(makeTest('positive', 200), 200)).toBe(true);
      expect(statusSatisfied(makeTest('positive', 200), 201)).toBe(false);
    });

    it('accepts any code in the class for non-positive tests', () => {
      // A negative test declaring 400 should not fail when the API answers 422.
      expect(statusSatisfied(makeTest('negative', 400), 422)).toBe(true);
      expect(statusSatisfied(makeTest('negative', 400), 200)).toBe(false);
      expect(statusSatisfied(makeTest('security', 403), 401)).toBe(true);
    });
  });

  describe('render helpers', () => {
    it('renders exact vs range assertions per language', () => {
      const positive = makeTest('positive', 200);
      const security = makeTest('security', 403);

      expect(renderStatusAssertionJs(positive, 'response.status', '  ')).toBe('  expect(response.status).toBe(200);');
      expect(renderStatusAssertionJs(security, 'response.status', '  ')).toContain('toBeGreaterThanOrEqual(400)');
      expect(renderStatusAssertionJs(security, 'response.status', '  ')).toContain('toBeLessThanOrEqual(499)');

      expect(renderStatusAssertionChai(positive, 'response.status', '  ')).toContain('to.equal(200)');
      expect(renderStatusAssertionChai(security, 'response.status', '  ')).toContain('to.be.at.least(400)');

      expect(renderStatusAssertionPy(positive, 'response.status_code', '    ')).toBe('    assert response.status_code == 200');
      expect(renderStatusAssertionPy(security, 'response.status_code', '    ')).toBe('    assert 400 <= response.status_code <= 499');

      expect(renderStatusAssertionGo(security, 'resp.StatusCode', 'string(respBody)', '\t')).toContain('resp.StatusCode < 400 || resp.StatusCode > 499');
      expect(renderStatusAssertionJava(security, 'response.getStatusCode()', 'body', '\t\t')).toContain('>= 400 && response.getStatusCode() <= 499');
    });
  });
});
