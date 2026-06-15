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

  it('warns about public-only access when no GitHub token is supplied', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await validateRepoAccess(githubRepo, {});

    expect(result.checks.some((c) => c.name === 'GitHub token' && c.status === 'warn')).toBe(true);
    // Token validity check is skipped when there is no token.
    expect(result.checks.some((c) => c.name === 'GitHub token validity')).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports an error with a decoded message on a 404 repo response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));

    const result = await validateRepoAccess(githubRepo, {});

    const access = result.checks.find((c) => c.name === 'GitHub repository access');
    expect(access?.status).toBe('error');
    expect(access?.detail).toContain('not found');
  });

  it('decodes a 401 as an authentication/scope failure', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));

    const result = await validateRepoAccess(githubRepo, {});
    const access = result.checks.find((c) => c.name === 'GitHub repository access');
    expect(access?.detail).toContain('Authentication failed');
  });

  it('checks GitLab host reachability and project access over HTTPS', async () => {
    const gitlabRepo: RepoRef = { platform: 'gitlab', owner: 'team', repo: 'service' };
    mockFetch
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // version
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // project

    const result = await validateRepoAccess(gitlabRepo, { gitlabToken: 'glpat_test' });

    expect(result.checks.some((c) => c.name === 'GitLab host reachability' && c.status === 'ok')).toBe(true);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://gitlab.com/api/v4/version');
  });

  it('rejects a malformed GitLab base URL before any API call', async () => {
    const gitlabRepo: RepoRef = {
      platform: 'gitlab',
      owner: 'team',
      repo: 'service',
      gitlabBaseUrl: 'not-a-url'
    };

    const result = await validateRepoAccess(gitlabRepo, {});

    expect(result.ok).toBe(false);
    expect(result.checks[0].name).toBe('GitLab base URL format');
    expect(mockFetch).not.toHaveBeenCalled();
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
