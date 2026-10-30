import { describe, expect, it } from 'vitest';
import { apiDirHint, bootRepoFor } from '@background/runner/bootTarget';
import { makeEndpoint } from '@shared/testing/factories';

const at = (filePath: string, source: 'fastapi' | 'openapi' = 'fastapi') =>
  makeEndpoint({ id: filePath, source, evidence: [{ filePath, reason: 'route' }] });

describe('bootRepoFor', () => {
  it('builds the slug and clone URL for GitHub and self-hosted GitLab', () => {
    expect(bootRepoFor({ platform: 'github', owner: 'srewoo', repo: 'FortKnoxx' })).toEqual({
      slug: 'github.com/srewoo/fortknoxx',
      cloneUrl: 'https://github.com/srewoo/FortKnoxx.git',
      platform: 'github'
    });
    expect(bootRepoFor({ platform: 'gitlab', owner: 'grp/sub', repo: 'api' }, 'https://git.acme.io/')).toMatchObject({
      slug: 'git.acme.io/grp/sub/api',
      cloneUrl: 'https://git.acme.io/grp/sub/api.git'
    });
  });
});

describe('apiDirHint', () => {
  it('returns the common parent of the route files', () => {
    expect(apiDirHint([at('backend/api/users.py'), at('backend/api/ai.py'), at('backend/server.py')])).toBe('backend');
  });

  it('falls back to the top-level folder holding most routes', () => {
    expect(apiDirHint([at('backend/a.py'), at('backend/b/c.py'), at('scripts/x.py')])).toBe('backend');
  });

  it('ignores spec files and returns nothing without code evidence', () => {
    expect(apiDirHint([at('docs/openapi.yaml', 'openapi')])).toBeUndefined();
    expect(apiDirHint([])).toBeUndefined();
  });

  it('is undefined for routes in the repo root', () => {
    expect(apiDirHint([at('server.py'), at('routes.py')])).toBeUndefined();
  });
});
