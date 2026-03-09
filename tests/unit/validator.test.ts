import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateRepoAccess } from '@background/repo/validator';
import type { RepoRef } from '@shared/types';

const githubRepo: RepoRef = {
  platform: 'github',
  owner: 'acme',
  repo: 'shop-api'
};

describe('validateRepoAccess', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('validates GitHub repo and token successfully', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await validateRepoAccess(githubRepo, { githubToken: 'ghp_test' });

    expect(result.ok).toBe(true);
    expect(result.checks.some((item) => item.name === 'GitHub repository access' && item.status === 'ok')).toBe(true);
    expect(result.checks.some((item) => item.name === 'GitHub token validity' && item.status === 'ok')).toBe(true);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ghp_test' })
      })
    );
  });

  it('rejects non-https GitLab base URLs before API calls', async () => {
    const gitlabRepo: RepoRef = {
      platform: 'gitlab',
      owner: 'team',
      repo: 'service',
      gitlabBaseUrl: 'http://gitlab.company.local'
    };

    const result = await validateRepoAccess(gitlabRepo, { gitlabToken: 'glpat_test' });

    expect(result.ok).toBe(false);
    expect(result.checks[0].name).toBe('GitLab base URL protocol');
    expect(result.checks[0].status).toBe('error');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
