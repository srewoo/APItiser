import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildArtifactZip } from '@background/generation/zipBuilder';
import { makeValidationSummary } from '@shared/testing/factories';
import type { GeneratedFile } from '@shared/types';

const files: GeneratedFile[] = [
  { path: 'tests/users.test.ts', content: 'describe("users", () => {});' },
  { path: 'README.md', content: '# Generated tests' }
];

describe('buildArtifactZip', () => {
  it('returns an artifact whose base64 zip contains all input files', async () => {
    const artifact = await buildArtifactZip('jest', files);
    expect(artifact.framework).toBe('jest');
    expect(artifact.files).toHaveLength(2);
    expect(artifact.zipBase64.length).toBeGreaterThan(0);

    // Round-trip the base64 zip and confirm the entries are present.
    const zip = await JSZip.loadAsync(artifact.zipBase64, { base64: true });
    expect(zip.file('tests/users.test.ts')).not.toBeNull();
    const readme = await zip.file('README.md')?.async('string');
    expect(readme).toContain('# Generated tests');
  });

  it('assigns a generated id and a default file name', async () => {
    const artifact = await buildArtifactZip('pytest', files);
    expect(artifact.id).toMatch(/^artifact/);
    expect(artifact.fileName).toBe('api-tests.zip');
  });

  it('encodes readiness into the file name and carries readiness metadata', async () => {
    const summary = makeValidationSummary();
    const artifact = await buildArtifactZip('jest', files, {
      readiness: 'production_candidate',
      readinessNotes: ['All checks passed'],
      validationSummary: summary
    });
    expect(artifact.fileName).toBe('api-tests-production_candidate.zip');
    expect(artifact.readiness).toBe('production_candidate');
    expect(artifact.readinessNotes).toEqual(['All checks passed']);
    expect(artifact.validationSummary).toEqual(summary);
  });

  it('produces a valid (empty) zip when given no files', async () => {
    const artifact = await buildArtifactZip('mocha', []);
    const zip = await JSZip.loadAsync(artifact.zipBase64, { base64: true });
    expect(Object.keys(zip.files)).toHaveLength(0);
  });
});
