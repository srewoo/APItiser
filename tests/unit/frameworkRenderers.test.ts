import { describe, expect, it } from 'vitest';
import { JestFrameworkAdapter } from '@background/generation/frameworks/jest';
import { MochaFrameworkAdapter } from '@background/generation/frameworks/mocha';
import { PytestFrameworkAdapter } from '@background/generation/frameworks/pytest';
import type { GeneratedTestCase, ProjectMeta } from '@shared/types';

const tests: GeneratedTestCase[] = [
  {
    endpointId: 'GET::/users',
    category: 'positive',
    title: 'returns users',
    request: {
      method: 'GET',
      path: '/users'
    },
    expected: {
      status: 200,
      contains: ['users']
    }
  },
  {
    endpointId: 'GET::/private',
    category: 'security',
    title: 'rejects missing auth',
    request: {
      method: 'GET',
      path: '/private',
      headers: {
        Authorization: 'Bearer {{API_TOKEN}}'
      }
    },
    expected: {
      status: 401
    }
  }
];

const projectMeta: ProjectMeta = {
  repo: {
    platform: 'github',
    owner: 'acme',
    repo: 'shop-api'
  },
  framework: 'jest',
  generatedAt: '2026-03-09T00:00:00.000Z',
  endpointCount: 1
};

describe('framework adapters', () => {
  it('renders jest files', () => {
    const adapter = new JestFrameworkAdapter();
    const files = adapter.render(tests, projectMeta);

    const content = files.map((file) => file.content).join('\n');

    expect(files[0].path).toContain('.test.js');
    expect(content).toContain('returns users');
    expect(content).toContain("require('undici')");
    expect(content).toContain('process.env.API_TOKEN');
  });

  it('renders pytest files', () => {
    const adapter = new PytestFrameworkAdapter();
    const files = adapter.render(tests, { ...projectMeta, framework: 'pytest' });
    const content = files.map((file) => file.content).join('\n');

    expect(files[0].path).toContain('.py');
    expect(content).toContain('assert response.status_code == 200');
    expect(content).toContain("os.getenv('API_TOKEN', 'replace-me')");
  });

  it('renders mocha files', () => {
    const adapter = new MochaFrameworkAdapter();
    const files = adapter.render(tests, { ...projectMeta, framework: 'mocha' });
    const content = files.map((file) => file.content).join('\n');

    expect(files[0].path).toContain('.spec.js');
    expect(content).toContain("const { expect } = require('chai');");
    expect(content).toContain("require('undici')");
    expect(content).toContain('process.env.API_TOKEN');
  });
});
