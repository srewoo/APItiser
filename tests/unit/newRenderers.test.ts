import { describe, expect, it } from 'vitest';
import { VitestFrameworkAdapter } from '@background/generation/frameworks/vitest';
import { PlaywrightFrameworkAdapter } from '@background/generation/frameworks/playwright';
import { getFrameworkAdapter } from '@background/generation/frameworks/registry';
import { makeGeneratedTestCase } from '@shared/testing/factories';
import type { GeneratedTestCase, ProjectMeta } from '@shared/types';

const tests: GeneratedTestCase[] = [
  makeGeneratedTestCase({
    endpointId: 'GET::/users',
    category: 'positive',
    title: 'returns users',
    request: {
      method: 'GET',
      path: '/users',
      headers: { Authorization: 'Bearer {{API_TOKEN}}' }
    },
    expected: {
      status: 200,
      contains: ['users']
    }
  }),
  makeGeneratedTestCase({
    endpointId: 'POST::/users',
    category: 'positive',
    title: 'creates a user',
    request: {
      method: 'POST',
      path: '/users',
      body: { name: 'Ada' },
      query: { dryRun: 'true' }
    },
    expected: {
      status: 201,
      contentType: 'application/json'
    }
  })
];

const projectMeta: ProjectMeta = {
  repo: {
    platform: 'github',
    owner: 'acme',
    repo: 'shop-api'
  },
  framework: 'vitest',
  generatedAt: '2026-03-09T00:00:00.000Z',
  endpointCount: 2
};

describe('VitestFrameworkAdapter', () => {
  const adapter = new VitestFrameworkAdapter();

  it('should render at least one file with vitest imports when given tests', () => {
    const files = adapter.render(tests, projectMeta);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = files.map((file) => file.content).join('\n');
    expect(content).toContain("from 'vitest'");
    expect(content).toContain('returns users');
    expect(content).toContain('/users');
    expect(content).toContain('expect(response.status).toBe(200)');
    expect(content).toContain('process.env.API_TOKEN');
    expect(files[0].path).toContain('.test.ts');
  });

  it('should render the POST method and 201 status assertion when given a create test', () => {
    const files = adapter.render(tests, projectMeta);
    const content = files.map((file) => file.content).join('\n');
    expect(content).toContain('"POST"');
    expect(content).toContain('expect(response.status).toBe(201)');
  });

  it('should render a parseable package.json support file when called', () => {
    const supportFiles = adapter.renderSupportFiles(projectMeta);
    const pkg = supportFiles.find((file) => file.path === 'package.json');
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg!.content);
    expect(parsed.devDependencies.vitest).toBeDefined();
    expect(supportFiles.some((file) => file.path === 'vitest.config.ts')).toBe(true);
  });

  it('should mention the vitest run command when rendering the readme', () => {
    const readme = adapter.renderReadme(projectMeta);
    expect(readme.content).toContain('npx vitest run');
  });
});

describe('PlaywrightFrameworkAdapter', () => {
  const adapter = new PlaywrightFrameworkAdapter();

  it('should render at least one file with @playwright/test imports when given tests', () => {
    const files = adapter.render(tests, { ...projectMeta, framework: 'playwright' });
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = files.map((file) => file.content).join('\n');
    expect(content).toContain("@playwright/test");
    expect(content).toContain('returns users');
    expect(content).toContain('/users');
    expect(content).toContain('expect(response.status()).toBe(200)');
    expect(content).toContain('process.env.API_TOKEN');
    expect(files[0].path).toContain('.spec.ts');
  });

  it('should map methods to request.<method> and honor body/query when given a create test', () => {
    const files = adapter.render(tests, { ...projectMeta, framework: 'playwright' });
    const content = files.map((file) => file.content).join('\n');
    expect(content).toContain('request.get(');
    expect(content).toContain('request.post(');
    expect(content).toContain('data:');
    expect(content).toContain('params:');
    expect(content).toContain('expect(response.status()).toBe(201)');
  });

  it('should render a parseable package.json support file when called', () => {
    const supportFiles = adapter.renderSupportFiles({ ...projectMeta, framework: 'playwright' });
    const pkg = supportFiles.find((file) => file.path === 'package.json');
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg!.content);
    expect(parsed.devDependencies['@playwright/test']).toBeDefined();
    expect(supportFiles.some((file) => file.path === 'playwright.config.ts')).toBe(true);
  });

  it('should mention the playwright test command when rendering the readme', () => {
    const readme = adapter.renderReadme({ ...projectMeta, framework: 'playwright' });
    expect(readme.content).toContain('npx playwright test');
  });
});

describe('framework registry', () => {
  it('should return the Vitest adapter when asked for vitest', () => {
    const adapter = getFrameworkAdapter('vitest');
    expect(adapter).toBeInstanceOf(VitestFrameworkAdapter);
    expect(adapter.framework).toBe('vitest');
  });

  it('should return the Playwright adapter when asked for playwright', () => {
    const adapter = getFrameworkAdapter('playwright');
    expect(adapter).toBeInstanceOf(PlaywrightFrameworkAdapter);
    expect(adapter.framework).toBe('playwright');
  });
});
