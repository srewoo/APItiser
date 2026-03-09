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

    expect(files[0].path).toContain('.test.js');
    expect(files[0].content).toContain('returns users');
  });

  it('renders pytest files', () => {
    const adapter = new PytestFrameworkAdapter();
    const files = adapter.render(tests, { ...projectMeta, framework: 'pytest' });

    expect(files[0].path).toContain('.py');
    expect(files[0].content).toContain('assert response.status_code == 200');
  });

  it('renders mocha files', () => {
    const adapter = new MochaFrameworkAdapter();
    const files = adapter.render(tests, { ...projectMeta, framework: 'mocha' });

    expect(files[0].path).toContain('.spec.js');
    expect(files[0].content).toContain("const { expect } = require('chai');");
  });
});
