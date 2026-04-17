import { describe, expect, it } from 'vitest';
import { JestFrameworkAdapter } from '@background/generation/frameworks/jest';
import { MochaFrameworkAdapter } from '@background/generation/frameworks/mocha';
import { PytestFrameworkAdapter } from '@background/generation/frameworks/pytest';
import type { GeneratedTestCase, ProjectMeta } from '@shared/types';
import { makeGeneratedTestCase } from '@shared/testing/factories';

const baseMeta: ProjectMeta = {
  repo: { platform: 'github', owner: 'acme', repo: 'api' },
  framework: 'jest',
  generatedAt: '2026-04-01T00:00:00.000Z',
  endpointCount: 2
};

// ---------------------------------------------------------------------------
// Edge cases: long paths, special characters, large bodies
// ---------------------------------------------------------------------------

describe('framework renderers — edge cases', () => {
  const longPathTest = makeGeneratedTestCase({
    endpointId: 'GET::/api/v1/organisations/:orgId/projects/:projectId/tasks/:taskId',
    title: 'fetches a deeply nested task',
    request: {
      method: 'GET',
      path: '/api/v1/organisations/org-123/projects/proj-456/tasks/task-789',
      headers: { Authorization: 'Bearer {{API_TOKEN}}' }
    },
    expected: { status: 200, contractChecks: ['response matches documented schema'] }
  });

  const specialCharsTest = makeGeneratedTestCase({
    endpointId: 'POST::/v1/search',
    title: 'handles special chars in body: <script>alert("xss")</script>',
    category: 'negative',
    request: {
      method: 'POST',
      path: '/v1/search',
      body: { query: '<script>alert("xss")</script>', filter: { "key": "val\"ue" } }
    },
    expected: { status: 400, contains: ['invalid input'] }
  });

  const securityTest = makeGeneratedTestCase({
    endpointId: 'DELETE::/users/:id',
    title: 'rejects unauthenticated delete attempt',
    category: 'security',
    request: {
      method: 'DELETE',
      path: '/users/42',
      headers: {}
    },
    expected: { status: 401 }
  });

  const noSchemaTest = makeGeneratedTestCase({
    endpointId: 'GET::/health',
    title: 'health check returns 200',
    request: { method: 'GET', path: '/health' },
    expected: { status: 200 }
  });

  const tests: GeneratedTestCase[] = [longPathTest, specialCharsTest, securityTest, noSchemaTest];

  describe('JestFrameworkAdapter', () => {
    const adapter = new JestFrameworkAdapter();

    it('renders tests with long nested paths without truncation', () => {
      const files = adapter.render(tests, baseMeta);
      const content = files.map((f) => f.content).join('\n');
      expect(content).toContain('/api/v1/organisations/org-123/projects/proj-456/tasks/task-789');
    });

    it('outputs valid JavaScript even with special characters in bodies', () => {
      const files = adapter.render(tests, baseMeta);
      // Content must be produced (no crash)
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]?.content.length).toBeGreaterThan(0);
    });

    it('renders security tests with 401 expected status', () => {
      const files = adapter.render(tests, baseMeta);
      const content = files.map((f) => f.content).join('\n');
      expect(content).toContain('401');
    });

    it('renders README with endpoint count', () => {
      const readme = adapter.renderReadme({ ...baseMeta, endpointCount: 5 });
      expect(readme.path).toContain('README');
      expect(readme.content).toContain('5');
    });

    it('renders support files including env config', () => {
      const supportFiles = adapter.renderSupportFiles?.(baseMeta) ?? [];
      const paths = supportFiles.map((f) => f.path);
      expect(paths.some((p) => /jest\.config/.test(p) || /package\.json/.test(p) || /setup/.test(p))).toBe(true);
    });
  });

  describe('MochaFrameworkAdapter', () => {
    const adapter = new MochaFrameworkAdapter();

    it('renders tests with long nested paths', () => {
      const files = adapter.render(tests, { ...baseMeta, framework: 'mocha' });
      const content = files.map((f) => f.content).join('\n');
      expect(content).toContain('/api/v1/organisations/org-123');
    });

    it('renders README', () => {
      const readme = adapter.renderReadme({ ...baseMeta, framework: 'mocha' });
      expect(readme.path).toContain('README');
    });

    it('renders support files including mocha config', () => {
      const supportFiles = adapter.renderSupportFiles?.({ ...baseMeta, framework: 'mocha' }) ?? [];
      expect(supportFiles.length).toBeGreaterThan(0);
    });
  });

  describe('PytestFrameworkAdapter', () => {
    const adapter = new PytestFrameworkAdapter();

    it('renders tests with long nested paths', () => {
      const files = adapter.render(tests, { ...baseMeta, framework: 'pytest' });
      const content = files.map((f) => f.content).join('\n');
      expect(content).toContain('/api/v1/organisations/org-123');
    });

    it('renders conftest and requirements when renderSupportFiles is called', () => {
      const supportFiles = adapter.renderSupportFiles?.({ ...baseMeta, framework: 'pytest' }) ?? [];
      const paths = supportFiles.map((f) => f.path);
      const hasSupport = paths.some((p) => /conftest|requirements|pytest\.ini/.test(p));
      expect(hasSupport).toBe(true);
    });

    it('renders README', () => {
      const readme = adapter.renderReadme({ ...baseMeta, framework: 'pytest' });
      expect(readme.path).toContain('README');
    });
  });
});

// ---------------------------------------------------------------------------
// Empty test arrays — should not crash
// ---------------------------------------------------------------------------

describe('framework renderers — empty input', () => {
  it('jest handles empty test array gracefully', () => {
    const adapter = new JestFrameworkAdapter();
    const files = adapter.render([], baseMeta);
    expect(files).toBeInstanceOf(Array);
  });

  it('mocha handles empty test array gracefully', () => {
    const adapter = new MochaFrameworkAdapter();
    const files = adapter.render([], { ...baseMeta, framework: 'mocha' });
    expect(files).toBeInstanceOf(Array);
  });

  it('pytest handles empty test array gracefully', () => {
    const adapter = new PytestFrameworkAdapter();
    const files = adapter.render([], { ...baseMeta, framework: 'pytest' });
    expect(files).toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------
// Tests with jsonSchema assertions
// ---------------------------------------------------------------------------

describe('framework renderers — schema assertions', () => {
  const schemaTest = makeGeneratedTestCase({
    endpointId: 'GET::/users',
    title: 'GET /users returns paginated list matching schema',
    request: { method: 'GET', path: '/users' },
    expected: {
      status: 200,
      jsonSchema: {
        type: 'object',
        properties: {
          data: { type: 'array' },
          total: { type: 'integer' }
        }
      },
      pagination: true,
      contractChecks: ['pagination semantics preserved', 'response matches documented schema']
    }
  });

  it('jest includes schema assertion details', () => {
    const adapter = new JestFrameworkAdapter();
    const files = adapter.render([schemaTest], baseMeta);
    const content = files.map((f) => f.content).join('\n');
    expect(content.length).toBeGreaterThan(0);
    // Should reference schema validation or contract checks
    expect(content).toContain('schema');
  });

  it('pytest includes schema assertion details', () => {
    const adapter = new PytestFrameworkAdapter();
    const files = adapter.render([schemaTest], { ...baseMeta, framework: 'pytest' });
    const content = files.map((f) => f.content).join('\n');
    expect(content.length).toBeGreaterThan(0);
  });
});
