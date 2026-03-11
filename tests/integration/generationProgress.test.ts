import { describe, expect, it } from 'vitest';
import { applyGenerationProgressToJob } from '@background/generation/testGenerator';
import { buildCoverage } from '@background/generation/coverage';
import type { ApiEndpoint, GeneratedTestCase, JobState } from '@shared/types';

describe('generation progress integration', () => {
  it('updates job state and computes coverage gaps', () => {
    const job: JobState = {
      jobId: 'job3',
      stage: 'generating',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 20,
      statusText: 'Generating',
      totalEndpoints: 2,
      completedBatches: 0,
      totalBatches: 2,
      endpoints: [
        {
          id: 'GET::/users',
          method: 'GET',
          path: '/users',
          source: 'express',
          pathParams: [],
          queryParams: [],
          responses: [{ status: '200' }],
          auth: 'none'
        },
        {
          id: 'POST::/orders',
          method: 'POST',
          path: '/orders',
          source: 'express',
          pathParams: [],
          queryParams: [],
          responses: [{ status: '201' }],
          auth: 'none'
        }
      ],
      generatedTests: []
    };

    const tests: GeneratedTestCase[] = [
      {
        endpointId: 'GET::/users',
        category: 'positive',
        title: 'valid list',
        request: { method: 'GET', path: '/users' },
        expected: { status: 200 }
      }
    ];

    const progressed = applyGenerationProgressToJob(job, {
      completedBatches: 1,
      totalBatches: 2,
      generatedTests: tests,
      batchDiagnostics: {
        batchIndex: 0,
        endpointIds: ['GET::/users'],
        provider: 'openai',
        repairAttempted: false,
        assessment: {
          passed: true,
          issues: []
        }
      }
    });

    expect(progressed.completedBatches).toBe(1);
    expect(progressed.progress).toBe(50);
    expect(progressed.qualityStatus).toBe('pending');

    const coverage = buildCoverage(job.endpoints as ApiEndpoint[], tests);
    expect(coverage.coveragePercent).toBe(50);
    expect(coverage.gaps.some((gap) => gap.includes('/orders'))).toBe(true);
  });
});
