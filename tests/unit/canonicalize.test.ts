import { describe, expect, it } from 'vitest';
import { canonicalizeEndpoints } from '@background/parser/canonicalize';
import { makeEndpoint } from '@shared/testing/factories';
import type { RepoFile } from '@shared/types';

describe('canonicalizeEndpoints', () => {
  it('dedupes endpoints sharing the same method and path', () => {
    const result = canonicalizeEndpoints(
      [
        makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users', source: 'express' }),
        makeEndpoint({ id: 'GET::/users#2', method: 'GET', path: '/users', source: 'openapi' })
      ],
      []
    );
    expect(result).toHaveLength(1);
  });

  it('keeps distinct method/path combinations separate and sorts them', () => {
    const result = canonicalizeEndpoints(
      [
        makeEndpoint({ id: 'POST::/users', method: 'POST', path: '/users' }),
        makeEndpoint({ id: 'GET::/accounts', method: 'GET', path: '/accounts' }),
        makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users' })
      ],
      []
    );
    expect(result).toHaveLength(3);
    // sorted by path, then method
    expect(result.map((e) => e.path)).toEqual(['/accounts', '/users', '/users']);
    const usersMethods = result.filter((e) => e.path === '/users').map((e) => e.method);
    expect(usersMethods).toEqual(['GET', 'POST']);
  });

  it('merges OpenAPI and code sources and records provenance', () => {
    const result = canonicalizeEndpoints(
      [
        makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users', source: 'express' }),
        makeEndpoint({ id: 'GET::/users#openapi', method: 'GET', path: '/users', source: 'openapi' })
      ],
      []
    );
    const meta = result[0]?.sourceMetadata;
    expect(meta?.mergedFromCode).toBe(true);
    expect(meta?.mergedFromOpenApi).toBe(true);
  });

  it('assigns a trust score and label to every endpoint', () => {
    const result = canonicalizeEndpoints([makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users' })], []);
    expect(typeof result[0]?.trustScore).toBe('number');
    expect(['high', 'medium', 'heuristic']).toContain(result[0]?.trustLabel);
  });

  it('flags endpoints that already have existing test coverage', () => {
    const files: RepoFile[] = [
      {
        path: 'tests/users.test.ts',
        content: `describe('users', () => { it('GET /users', () => request(app).get('/users')); });`
      }
    ];
    const result = canonicalizeEndpoints([makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users' })], files);
    expect(result[0]?.sourceMetadata?.hasExistingTests).toBe(true);
  });

  it('returns an empty array for no input', () => {
    expect(canonicalizeEndpoints([], [])).toEqual([]);
  });
});
