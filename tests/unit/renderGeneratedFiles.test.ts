import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/constants';
import { renderGeneratedFiles } from '@background/generation/testGenerator';
import type { ExtensionSettings, GeneratedTestCase, RepoRef } from '@shared/types';

const repo: RepoRef = {
  platform: 'github',
  owner: 'acme',
  repo: 'shop-api'
};

const tests: GeneratedTestCase[] = [
  {
    endpointId: 'GET::/users/:id',
    category: 'positive',
    title: 'gets user',
    request: {
      method: 'GET',
      path: '/users/:id'
    },
    expected: {
      status: 200,
      contains: ['user']
    }
  }
];

const buildSettings = (framework: ExtensionSettings['framework']): ExtensionSettings => ({
  ...DEFAULT_SETTINGS,
  framework
});

describe('renderGeneratedFiles', () => {
  it('renders resource-based Jest files with support config', () => {
    const files = renderGeneratedFiles(buildSettings('jest'), repo, 1, tests);

    expect(files.some((file) => file.path === 'tests/users/get-users.test.js')).toBe(true);
    expect(files.some((file) => file.path === 'jest.config.cjs')).toBe(true);
  });

  it('renders framework support files for Mocha and Pytest', () => {
    const mochaFiles = renderGeneratedFiles(buildSettings('mocha'), repo, 1, tests);
    const pytestFiles = renderGeneratedFiles(buildSettings('pytest'), repo, 1, tests);

    expect(mochaFiles.some((file) => file.path === '.mocharc.json')).toBe(true);
    expect(pytestFiles.some((file) => file.path === 'pytest.ini')).toBe(true);
    expect(pytestFiles.some((file) => file.path === 'requirements.txt')).toBe(true);
  });
});
