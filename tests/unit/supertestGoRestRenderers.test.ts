import { describe, expect, it } from 'vitest';
import { SupertestFrameworkAdapter } from '@background/generation/frameworks/supertest';
import { GoTestFrameworkAdapter } from '@background/generation/frameworks/gotest';
import { RestAssuredFrameworkAdapter } from '@background/generation/frameworks/restassured';
import { makeGeneratedTestCase, makeValidationSummary } from '@shared/testing/factories';
import type { GeneratedTestCase, ProjectMeta } from '@shared/types';

// A deliberately diverse set of cases to exercise the many branches inside each
// renderer: every auth placeholder, request bodies, query params, path params in
// both `:id` and `{id}` styles, and every assertion kind (contentType,
// responseHeaders, contains, jsonSchema, pagination).
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
    expected: {
      status: 200,
      contentType: 'application/json',
      contains: ['users'],
      pagination: true,
      responseHeaders: { 'X-Total-Count': '42' }
    }
  }),
  makeGeneratedTestCase({
    endpointId: 'POST::/users',
    category: 'positive',
    title: 'creates a user',
    request: {
      method: 'POST',
      path: '/users',
      headers: { 'X-API-Key': '{{API_KEY}}' },
      body: { name: 'Ada', tags: ['a', 'b'] }
    },
    expected: {
      status: 201,
      jsonSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }
    }
  }),
  makeGeneratedTestCase({
    endpointId: 'DELETE::/orgs/{orgId}/users/:userId',
    category: 'security',
    title: 'rejects unauthorized delete',
    trustLabel: 'high',
    trustScore: 91,
    request: {
      method: 'DELETE',
      path: '/orgs/{orgId}/users/:userId',
      headers: { 'X-CSRF-Token': '{{CSRF_TOKEN}}' }
    },
    expected: { status: 403 }
  })
];

const projectMeta: ProjectMeta = {
  repo: { platform: 'github', owner: 'acme', repo: 'shop-api' },
  framework: 'supertest',
  generatedAt: '2026-03-09T00:00:00.000Z',
  endpointCount: 3,
  readiness: 'validated',
  readinessNotes: ['All live checks passed'],
  validationSummary: makeValidationSummary({ attempted: 3, passed: 3 })
};

describe('SupertestFrameworkAdapter', () => {
  const adapter = new SupertestFrameworkAdapter();

  it('renders test files referencing supertest and the test titles', () => {
    const files = adapter.render(tests, projectMeta);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = files.map((f) => f.content).join('\n');
    expect(content).toContain('supertest');
    expect(content).toContain('lists users');
    expect(content).toContain('creates a user');
  });

  it('resolves auth placeholders to process.env expressions', () => {
    const content = adapter
      .render(tests, projectMeta)
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('process.env.API_TOKEN');
    expect(content).toContain('process.env.API_KEY');
    expect(content).toContain('process.env.CSRF_TOKEN');
  });

  it('emits status, body and query assertions', () => {
    const content = adapter
      .render(tests, projectMeta)
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('201'); // positive test keeps an exact status assertion
    // The security test (declared 403) asserts the 4xx class, not the exact code.
    expect(content).toContain('toBeGreaterThanOrEqual(400)');
    expect(content).toContain('toBeLessThanOrEqual(499)');
    expect(content).toMatch(/\.query\(/);
  });

  it('produces a README and support files', () => {
    const readme = adapter.renderReadme(projectMeta);
    expect(readme.path).toBe('README.md');
    expect(readme.content).toContain('acme/shop-api');
    expect(adapter.renderSupportFiles(projectMeta)).toBeInstanceOf(Array);
  });

  it('returns an empty array for no tests', () => {
    expect(adapter.render([], projectMeta)).toEqual([]);
  });
});

describe('GoTestFrameworkAdapter', () => {
  const adapter = new GoTestFrameworkAdapter();

  it('renders valid Go test scaffolding with package and imports', () => {
    const files = adapter.render(tests, { ...projectMeta, framework: 'gotest' });
    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = files.map((f) => f.content).join('\n');
    expect(content).toContain('package ');
    expect(content).toContain('func Test_');
    expect(content).toContain('net/http');
    expect(content).toContain('testing');
  });

  it('resolves auth placeholders to getEnv calls', () => {
    const content = adapter
      .render(tests, projectMeta)
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('getEnv("API_TOKEN"');
    expect(content).toContain('getEnv("API_KEY"');
    expect(content).toContain('getEnv("CSRF_TOKEN"');
  });

  it('emits status checks and content-type / header / contains assertions', () => {
    const content = adapter
      .render(tests, projectMeta)
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('resp.StatusCode');
    expect(content).toContain('Content-Type');
    expect(content).toContain('X-Total-Count');
    expect(content).toContain('strings.Contains');
  });

  it('writes a go.mod support file and README', () => {
    const support = adapter.renderSupportFiles(projectMeta);
    expect(support.some((f) => f.path === 'go.mod')).toBe(true);
    expect(adapter.renderReadme(projectMeta).content).toContain('Go Tests');
  });

  it('renders a go.mod even with no project meta', () => {
    expect(adapter.renderSupportFiles().some((f) => f.path === 'go.mod')).toBe(true);
  });
});

describe('RestAssuredFrameworkAdapter', () => {
  const adapter = new RestAssuredFrameworkAdapter();

  it('renders Java RestAssured classes referencing the framework', () => {
    const files = adapter.render(tests, { ...projectMeta, framework: 'restassured' });
    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = files.map((f) => f.content).join('\n');
    expect(content.toLowerCase()).toContain('restassured');
    expect(content).toMatch(/class \w+/);
  });

  it('emits status expectations for each case', () => {
    const content = adapter
      .render(tests, projectMeta)
      .map((f) => f.content)
      .join('\n');
    expect(content).toContain('200'); // positive tests keep exact assertEquals
    expect(content).toContain('201');
    // Security test (declared 403) asserts the 4xx class via assertTrue range.
    expect(content).toContain('>= 400 && response.getStatusCode() <= 499');
  });

  it('produces README and support files (e.g. pom.xml / build config)', () => {
    const readme = adapter.renderReadme(projectMeta);
    expect(readme.path).toBe('README.md');
    const support = adapter.renderSupportFiles(projectMeta);
    expect(support.length).toBeGreaterThanOrEqual(1);
  });
});
