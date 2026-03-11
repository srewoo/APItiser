import { describe, expect, it } from 'vitest';
import { assessReadiness } from '@background/generation/readiness';
import { renderGeneratedFiles } from '@background/generation/testGenerator';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { GeneratedTestCase, RepoRef, ValidationSummary } from '@shared/types';

const repo: RepoRef = {
  platform: 'github',
  owner: 'acme',
  repo: 'shop-api'
};

const tests: GeneratedTestCase[] = [
  {
    endpointId: 'GET::/users',
    category: 'positive',
    title: 'lists users',
    trustLabel: 'high',
    trustScore: 0.92,
    request: {
      method: 'GET',
      path: '/users'
    },
    expected: {
      status: 200,
      contentType: 'application/json',
      jsonSchema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { name: 'id', required: true, type: 'integer' }
          }
        }
      },
      contractChecks: ['response matches schema']
    }
  }
];

const passingSummary: ValidationSummary = {
  attempted: 1,
  passed: 1,
  failed: 0,
  repaired: 0,
  skipped: 0,
  lastValidatedAt: Date.now(),
  results: []
};

describe('readiness assessment', () => {
  it('marks fully validated strong tests as production candidates', () => {
    const readiness = assessReadiness(tests, passingSummary);

    expect(readiness.readiness).toBe('production_candidate');
    expect(readiness.notes).toEqual([]);
  });

  it('requires review when validation did not run', () => {
    const readiness = assessReadiness(tests, {
      ...passingSummary,
      attempted: 0,
      passed: 0,
      skipped: 1,
      notRunReason: 'Base URL not configured.'
    });

    expect(readiness.readiness).toBe('review_required');
    expect(readiness.notes[0]).toContain('Base URL not configured');
  });
});

describe('renderGeneratedFiles', () => {
  it('packages a validation report alongside generated tests', () => {
    const files = renderGeneratedFiles(
      DEFAULT_SETTINGS,
      repo,
      1,
      tests,
      {
        readiness: 'validated',
        readinessNotes: ['1 test still relies on heuristic evidence.'],
        validationSummary: passingSummary
      }
    );

    const report = files.find((file) => file.path === 'validation-report.json');
    const readme = files.find((file) => file.path === 'README.md');

    expect(report).toBeDefined();
    expect(report?.content).toContain('"readiness": "validated"');
    expect(readme?.content).toContain('Readiness: validated');
    expect(files.find((file) => file.path === '.env.example')?.content).toContain('API_KEY=');
  });
});
