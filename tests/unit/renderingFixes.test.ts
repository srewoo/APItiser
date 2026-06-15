import { describe, expect, it } from 'vitest';
import { JestFrameworkAdapter } from '@background/generation/frameworks/jest';
import { SupertestFrameworkAdapter } from '@background/generation/frameworks/supertest';
import { PytestFrameworkAdapter } from '@background/generation/frameworks/pytest';
import { renderGeneratedFiles } from '@background/generation/testGenerator';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { GeneratedTestCase, ProjectMeta, RepoRef } from '@shared/types';

const projectMeta: ProjectMeta = {
  repo: { platform: 'github', owner: 'acme', repo: 'shop-api' },
  generatedAt: '2026-06-15T00:00:00.000Z',
  framework: 'jest',
  endpointCount: 1
};

const schemaTest: GeneratedTestCase = {
  endpointId: 'GET::/users',
  category: 'positive',
  title: 'lists users',
  trustLabel: 'high',
  trustScore: 90,
  request: { method: 'GET', path: '/users' },
  expected: {
    status: 200,
    jsonSchema: { type: 'array', items: { type: 'object', properties: { id: { name: 'id', required: true, type: 'integer' } } } },
    contractChecks: ['auth boundary enforced', 'response matches documented schema']
  }
};

const chainedTest: GeneratedTestCase = {
  endpointId: 'GET::/users/{id}',
  category: 'positive',
  title: 'gets a user by id',
  request: { method: 'GET', path: '/users/{{USER_ID}}' },
  expected: { status: 200 }
};

describe('contract checks render as documented comments, not tautologies', () => {
  it('jest renders contract expectations as comments and never asserts typeof === string', () => {
    const content = new JestFrameworkAdapter().render([schemaTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('// Contract expectation (verify manually): auth boundary enforced');
    expect(content).not.toContain("expect(typeof contractCheck).toBe('string')");
  });

  it('pytest renders contract expectations as comments and never asserts isinstance str', () => {
    const content = new PytestFrameworkAdapter().render([schemaTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('# Contract expectation (verify manually): auth boundary enforced');
    expect(content).not.toContain('assert isinstance(contract_check, str)');
  });
});

describe('supertest emits schema and pagination assertions (previously dropped)', () => {
  it('renders an assertSchemaShape helper and call for positive schema tests', () => {
    const content = new SupertestFrameworkAdapter().render([schemaTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('const assertSchemaShape');
    expect(content).toContain('assertSchemaShape(');
    expect(content).toContain('response.body');
  });
});

describe('isPaginatedShape accepts domain-keyed list envelopes (not just items/results/data)', () => {
  const paginatedTest: GeneratedTestCase = {
    endpointId: 'GET::/api/alerts/events',
    category: 'positive',
    title: 'lists events',
    request: { method: 'GET', path: '/api/alerts/events', query: { limit: 1 } },
    expected: { status: 200, pagination: true }
  };

  it('jest emits a paginated check that recognizes any array-valued key', () => {
    const content = new JestFrameworkAdapter().render([paginatedTest], projectMeta).map((f) => f.content).join('\n');
    // The generated helper must accept e.g. {"events":[...]} via an array-valued key.
    expect(content).toContain('Object.values(value).some((entry) => Array.isArray(entry))');
    expect(content).toContain('isPaginatedShape');
  });

  it('pytest emits a paginated check that recognizes any list-valued key', () => {
    const content = new PytestFrameworkAdapter().render([paginatedTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('any(isinstance(v, list) for v in value.values())');
  });
});

describe('.env.example surfaces {{NAME}} placeholders from header values', () => {
  it('lists a header-only runtime token (e.g. xtoken) so it is not silently missing', () => {
    const repo: RepoRef = { platform: 'github', owner: 'srewoo', repo: 'agentX' };
    const headerTokenTest: GeneratedTestCase = {
      endpointId: 'POST::/api/performance/evaluate',
      category: 'positive',
      title: 'evaluates',
      request: { method: 'POST', path: '/api/performance/evaluate', headers: { 'x-token': '{{xtoken}}' }, body: {} },
      expected: { status: 200 }
    };
    const files = renderGeneratedFiles(DEFAULT_SETTINGS, repo, 1, [headerTokenTest]);
    const env = files.find((f) => f.path === '.env.example')?.content ?? '';
    expect(env).toContain('xtoken=');
    // The four canonical auth tokens are listed once each, not duplicated as discovered names.
    expect(env.match(/^API_TOKEN=/gm)?.length ?? 0).toBe(1);
  });
});

describe('{{NAME}} runtime placeholders render as environment reads', () => {
  it('jest emits process.env.USER_ID in the request URL', () => {
    const content = new JestFrameworkAdapter().render([chainedTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain("process.env.USER_ID || 'replace-me'");
    expect(content).not.toContain('{{USER_ID}}');
  });

  it('pytest emits os.getenv("USER_ID") in the request URL', () => {
    const content = new PytestFrameworkAdapter().render([chainedTest], projectMeta).map((f) => f.content).join('\n');
    expect(content).toContain('os.getenv("USER_ID"');
    expect(content).not.toContain('{{USER_ID}}');
  });
});
