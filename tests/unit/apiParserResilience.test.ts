import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEndpoint } from '@shared/types';

const codeEndpoint: ApiEndpoint = {
  id: 'GET::/health',
  method: 'GET',
  path: '/health',
  source: 'express',
  auth: 'none',
  pathParams: [],
  queryParams: [],
  responses: [{ status: '200' }]
};

vi.mock('@background/parser/codeRouteParser', () => ({
  parseCodeRoutes: vi.fn(() => [codeEndpoint])
}));

vi.mock('@background/parser/openApiParser', () => ({
  parseOpenApiSpecs: vi.fn(() => {
    throw new Error('document is not defined');
  })
}));

vi.mock('@background/parser/canonicalize', () => ({
  canonicalizeEndpoints: vi.fn((endpoints: ApiEndpoint[]) => endpoints)
}));

import { parseApiMap } from '@background/parser/apiParser';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseApiMap resilience', () => {
  it('continues scanning code routes when OpenAPI parsing fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const endpoints = parseApiMap([
      {
        path: 'src/app.ts',
        content: "app.get('/health', handler);"
      }
    ]);

    expect(endpoints).toEqual([codeEndpoint]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[APItiser] OpenAPI parsing failed during scan.',
      expect.any(Error)
    );
  });
});
