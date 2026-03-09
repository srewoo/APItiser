import { describe, expect, it } from 'vitest';
import { detectExistingTestCoverage } from '@background/parser/testCoverageDetector';
import type { ApiEndpoint } from '@shared/types';

describe('detectExistingTestCoverage', () => {
  it('marks endpoints as covered when matching test files contain method and path', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'express',
        pathParams: [{ name: 'id', required: true, type: 'string' }],
        queryParams: [],
        responses: [{ status: '200' }],
        auth: 'none'
      }
    ];

    const files = [
      {
        path: 'tests/users/getUser.test.ts',
        content: "it('works', async () => { await request(app).get('/users/42'); });"
      }
    ];

    const covered = detectExistingTestCoverage(files, endpoints, ['tests']);
    expect(covered).toEqual(['GET::/users/:id']);
  });

  it('marks endpoints as covered when test path is built dynamically', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'express',
        pathParams: [{ name: 'id', required: true, type: 'string' }],
        queryParams: [],
        responses: [{ status: '200' }],
        auth: 'none'
      }
    ];

    const files = [
      {
        path: 'tests/users/getUser.spec.ts',
        content: "it('works', async () => { await request(app).get('/users/' + userId); });"
      }
    ];

    const covered = detectExistingTestCoverage(files, endpoints, ['tests']);
    expect(covered).toEqual(['GET::/users/:id']);
  });
});
