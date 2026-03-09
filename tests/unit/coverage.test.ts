import { describe, expect, it } from 'vitest';
import { buildCoverage } from '@background/generation/coverage';
import type { ApiEndpoint, GeneratedTestCase } from '@shared/types';

describe('buildCoverage', () => {
  it('reports missing security tests only when security category is required', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users',
        method: 'GET',
        path: '/users',
        source: 'express',
        pathParams: [],
        queryParams: [],
        responses: [{ status: '200' }],
        auth: 'none'
      }
    ];

    const tests: GeneratedTestCase[] = [
      {
        endpointId: 'GET::/users',
        category: 'positive',
        title: 'gets users',
        request: {
          method: 'GET',
          path: '/users'
        },
        expected: {
          status: 200
        }
      }
    ];

    const withoutSecurity = buildCoverage(endpoints, tests, [], ['positive', 'negative', 'edge']);
    expect(withoutSecurity.gaps.some((gap) => gap.includes('security'))).toBe(false);

    const withSecurity = buildCoverage(endpoints, tests, [], ['positive', 'negative', 'edge', 'security']);
    expect(withSecurity.gaps.some((gap) => gap.includes('security'))).toBe(true);
  });
});
