import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PytestFrameworkAdapter } from '@background/generation/frameworks/pytest';
import { makeGeneratedTestCase } from '@shared/testing/factories';
import type { GeneratedTestCase, ProjectMeta } from '@shared/types';

const projectMeta: ProjectMeta = {
  repo: { platform: 'github', owner: 'srewoo', repo: 'agentX' },
  framework: 'pytest',
  generatedAt: '2026-06-15T00:00:00.000Z',
  endpointCount: 4
};

// Cases chosen to trigger every historical generator bug:
//  - a brace path param (would break an f-string URL)
//  - a hyphenated resource (invalid Python identifier in the fn name)
//  - a custom {{xtoken}} placeholder header (must resolve from env, not ship literally)
//  - a jsonSchema (exercises the assert_schema_shape helper that had stray backticks)
const tests: GeneratedTestCase[] = [
  makeGeneratedTestCase({
    endpointId: 'GET::/api/paper-trades/{tradeId}',
    category: 'positive',
    title: 'gets a paper trade by id',
    request: {
      method: 'GET',
      path: '/api/paper-trades/{tradeId}',
      headers: { 'x-token': '{{xtoken}}', Authorization: 'Bearer {{API_TOKEN}}' }
    },
    expected: {
      status: 200,
      jsonSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }
    }
  }),
  makeGeneratedTestCase({
    endpointId: 'POST::/api/ai-analysis',
    category: 'negative',
    title: 'rejects analysis without auth',
    request: { method: 'POST', path: '/api/ai-analysis', headers: {}, body: { ticker: 'AAPL' } },
    expected: { status: 401 }
  })
];

const adapter = new PytestFrameworkAdapter();
const files = adapter.render(tests, projectMeta);
const output = files.map((f) => f.content).join('\n');

describe('PytestFrameworkAdapter — output validity', () => {
  it('emits no stray backticks', () => {
    expect(output).not.toContain('`');
  });

  it('uses only valid Python identifiers for every generated function', () => {
    const defs = output.match(/^def (\w+)\(/gm) ?? [];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const name = def.replace(/^def /, '').replace(/\($/, '');
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it('builds URLs by concatenation so brace paths do not become f-string fields', () => {
    expect(output).not.toContain('url=f"{BASE_URL}');
    expect(output).toContain('BASE_URL + "/api/paper-trades/{tradeId}"');
  });

  it('resolves {{placeholder}} headers from the environment instead of shipping literals', () => {
    expect(output).not.toContain('{{xtoken}}');
    expect(output).toContain("os.getenv('xtoken', 'replace-me')");
    expect(output).toContain("os.getenv('API_TOKEN', 'replace-me')");
  });
});

describe('PytestFrameworkAdapter — compiles under a real Python interpreter', () => {
  let python: string | null = null;
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      python = candidate;
      break;
    } catch {
      // try next
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'apitiser-pytest-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.runIf(python)('py_compiles every generated test file without SyntaxError', () => {
    const paths: string[] = [];
    for (const file of files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.content);
      if (full.endsWith('.py')) paths.push(full);
    }
    expect(paths.length).toBeGreaterThan(0);
    // Throws (failing the test) if any file has a SyntaxError.
    expect(() => execFileSync(python as string, ['-m', 'py_compile', ...paths], { stdio: 'pipe' })).not.toThrow();
  });
});
