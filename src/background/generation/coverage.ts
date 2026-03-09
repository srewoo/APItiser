import type { ApiEndpoint, CoverageSummary, GeneratedTestCase } from '@shared/types';

export const buildCoverage = (
  endpoints: ApiEndpoint[],
  tests: GeneratedTestCase[],
  existingCoveredEndpointIds: string[] = []
): CoverageSummary => {
  const testsByEndpoint = new Map<string, GeneratedTestCase[]>();
  const existingCovered = new Set(existingCoveredEndpointIds);

  for (const test of tests) {
    if (!testsByEndpoint.has(test.endpointId)) {
      testsByEndpoint.set(test.endpointId, []);
    }
    testsByEndpoint.get(test.endpointId)?.push(test);
  }

  const covered = endpoints.filter((endpoint) => existingCovered.has(endpoint.id) || testsByEndpoint.has(endpoint.id)).length;
  const coveragePercent = endpoints.length === 0 ? 0 : Math.round((covered / endpoints.length) * 100);

  const gaps: string[] = [];

  for (const endpoint of endpoints) {
    if (existingCovered.has(endpoint.id)) {
      continue;
    }

    const endpointTests = testsByEndpoint.get(endpoint.id) ?? [];
    const categories = new Set(endpointTests.map((item) => item.category));
    if (!categories.has('positive')) {
      gaps.push(`Missing positive tests for ${endpoint.method} ${endpoint.path}`);
    }
    if (!categories.has('negative')) {
      gaps.push(`Missing negative tests for ${endpoint.method} ${endpoint.path}`);
    }
    if (!categories.has('edge')) {
      gaps.push(`Missing edge tests for ${endpoint.method} ${endpoint.path}`);
    }
  }

  return {
    endpointsDetected: endpoints.length,
    testsGenerated: tests.length,
    coveragePercent,
    gaps: gaps.slice(0, 20)
  };
};
