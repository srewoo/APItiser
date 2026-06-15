import { describe, expect, it } from 'vitest';
import { buildPostmanCollection, buildPostmanEnvironment } from '@background/generation/postmanExport';
import { makeEndpoint, makeGeneratedTestCase, makeRepoRef } from '@shared/testing/factories';
import type { ApiEndpoint, GeneratedTestCase } from '@shared/types';

const repo = makeRepoRef({ owner: 'acme', repo: 'shop-api' });

const endpoints: ApiEndpoint[] = [
  makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users', summary: 'List users' }),
  makeEndpoint({ id: 'POST::/users', method: 'POST', path: '/users' }),
  makeEndpoint({ id: 'GET::/orgs/{orgId}/repos', method: 'GET', path: '/orgs/{orgId}/repos' })
];

const tests: GeneratedTestCase[] = [
  makeGeneratedTestCase({
    endpointId: 'GET::/users',
    category: 'positive',
    title: 'lists users',
    request: {
      method: 'GET',
      path: '/users',
      headers: { Authorization: 'Bearer {{API_TOKEN}}' },
      query: { page: '1', limit: '20' }
    },
    expected: { status: 200, contentType: 'application/json', contains: ['users'], pagination: true }
  }),
  makeGeneratedTestCase({
    endpointId: 'POST::/users',
    category: 'positive',
    title: 'creates a user',
    request: {
      method: 'POST',
      path: '/users',
      headers: { 'X-API-Key': '{{API_KEY}}' },
      body: { name: 'Ada' }
    },
    expected: {
      status: 201,
      jsonSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      responseHeaders: { Location: '/users/1' }
    }
  }),
  makeGeneratedTestCase({
    endpointId: 'GET::/orgs/{orgId}/repos',
    category: 'edge',
    title: 'lists repos for org with colon param',
    request: { method: 'GET', path: '/orgs/:orgId/repos', headers: {} },
    expected: { status: 200 }
  })
];

const parse = () => JSON.parse(buildPostmanCollection(repo, tests, endpoints));

describe('buildPostmanCollection', () => {
  it('produces a valid v2.1.0 collection with repo-named info', () => {
    const c = parse();
    expect(c.info.schema).toContain('v2.1.0');
    expect(c.info.name).toContain('acme/shop-api');
    expect(Array.isArray(c.item)).toBe(true);
  });

  it('groups items into resource folders by first stable path segment', () => {
    const c = parse();
    const folderNames = c.item.map((f: { name: string }) => f.name);
    expect(folderNames).toContain('users');
    expect(folderNames).toContain('orgs');
  });

  it('declares baseUrl, token and detected path/query variables', () => {
    const c = parse();
    const keys = c.variable.map((v: { key: string }) => v.key);
    expect(keys).toContain('baseUrl');
    expect(keys).toContain('API_TOKEN');
    expect(keys).toContain('orgId'); // path variable harvested from /orgs/:orgId
    expect(keys).toContain('page'); // query param harvested
  });

  it('builds test scripts asserting status, content-type, schema and pagination', () => {
    const raw = buildPostmanCollection(repo, tests, endpoints);
    expect(raw).toContain('pm.response.to.have.status(200)');
    expect(raw).toContain('pm.response.to.have.status(201)');
    expect(raw).toContain('Content-Type');
    expect(raw).toContain('JSON shape');
    expect(raw).toContain('Paginated shape');
  });

  it('attaches a JSON body for write requests and bearer/apikey auth blocks', () => {
    const raw = buildPostmanCollection(repo, tests, endpoints);
    expect(raw).toContain('"mode": "raw"');
    expect(raw).toContain('Ada'); // body is JSON-in-JSON, so quotes are escaped
    expect(raw).toContain('bearer');
    expect(raw).toContain('apikey');
  });

  it('honours a custom base URL', () => {
    const c = JSON.parse(buildPostmanCollection(repo, tests, endpoints, 'https://api.example.com'));
    const baseUrl = c.variable.find((v: { key: string }) => v.key === 'baseUrl');
    expect(baseUrl.value).toBe('https://api.example.com');
  });

  it('handles an empty test set without throwing', () => {
    const c = JSON.parse(buildPostmanCollection(repo, [], endpoints));
    expect(c.item).toEqual([]);
  });
});

describe('buildPostmanEnvironment', () => {
  it('produces an environment with baseUrl and secret token slots', () => {
    const env = JSON.parse(buildPostmanEnvironment('https://api.example.com'));
    expect(env._postman_variable_scope).toBe('environment');
    const baseUrl = env.values.find((v: { key: string }) => v.key === 'baseUrl');
    expect(baseUrl.value).toBe('https://api.example.com');
    expect(env.values.some((v: { key: string; type: string }) => v.key === 'API_TOKEN' && v.type === 'secret')).toBe(
      true
    );
  });

  it('defaults the base URL to localhost', () => {
    const env = JSON.parse(buildPostmanEnvironment());
    const baseUrl = env.values.find((v: { key: string }) => v.key === 'baseUrl');
    expect(baseUrl.value).toBe('http://localhost:3000');
  });
});
