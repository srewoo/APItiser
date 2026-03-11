import { describe, expect, it } from 'vitest';
import { parseRepoFromUrl } from '@shared/repo';

describe('parseRepoFromUrl — GitHub', () => {
  it('parses a simple GitHub repo URL', () => {
    const result = parseRepoFromUrl('https://github.com/acme/my-repo');
    expect(result).toMatchObject({
      platform: 'github',
      owner: 'acme',
      repo: 'my-repo'
    });
    expect(result?.branch).toBeUndefined();
    expect(result?.path).toBeUndefined();
  });

  it('parses a GitHub URL with branch', () => {
    const result = parseRepoFromUrl('https://github.com/acme/my-repo/tree/main');
    expect(result).toMatchObject({
      platform: 'github',
      owner: 'acme',
      repo: 'my-repo',
      branch: 'main'
    });
  });

  it('parses a GitHub URL with branch and sub-path', () => {
    const result = parseRepoFromUrl('https://github.com/acme/my-repo/tree/main/src/api');
    expect(result).toMatchObject({
      platform: 'github',
      owner: 'acme',
      repo: 'my-repo',
      branch: 'main',
      path: 'src/api'
    });
  });

  it('strips .git suffix from repo name', () => {
    const result = parseRepoFromUrl('https://github.com/acme/my-repo.git');
    expect(result?.repo).toBe('my-repo');
  });

  it('is case-insensitive for github.com', () => {
    const result = parseRepoFromUrl('HTTPS://GITHUB.COM/Acme/Repo');
    expect(result?.platform).toBe('github');
    expect(result?.owner).toBe('Acme');
  });
});

describe('parseRepoFromUrl — GitLab (gitlab.com)', () => {
  it('parses a simple GitLab repo URL', () => {
    const result = parseRepoFromUrl('https://gitlab.com/acme/my-repo');
    expect(result).toMatchObject({
      platform: 'gitlab',
      owner: 'acme',
      repo: 'my-repo',
      gitlabBaseUrl: 'https://gitlab.com'
    });
  });

  it('parses a GitLab URL with branch and path', () => {
    const result = parseRepoFromUrl('https://gitlab.com/acme/my-repo/-/tree/develop/src');
    expect(result).toMatchObject({
      platform: 'gitlab',
      owner: 'acme',
      repo: 'my-repo',
      branch: 'develop',
      path: 'src'
    });
  });

  it('handles nested GitLab groups (owner with slashes)', () => {
    const result = parseRepoFromUrl('https://gitlab.com/group/subgroup/my-repo');
    expect(result).toMatchObject({
      platform: 'gitlab',
      owner: 'group/subgroup',
      repo: 'my-repo'
    });
  });

  it('handles deeply nested GitLab groups with branch', () => {
    const result = parseRepoFromUrl('https://gitlab.com/a/b/c/my-repo/-/tree/feat/some-branch');
    expect(result?.owner).toBe('a/b/c');
    expect(result?.repo).toBe('my-repo');
    expect(result?.branch).toBe('feat');
  });

  it('strips .git suffix from GitLab repo name', () => {
    const result = parseRepoFromUrl('https://gitlab.com/acme/my-repo.git');
    expect(result?.repo).toBe('my-repo');
  });
});

describe('parseRepoFromUrl — Self-hosted GitLab', () => {
  it('parses a self-hosted GitLab URL when base URL matches', () => {
    const result = parseRepoFromUrl(
      'https://git.company.com/team/project',
      'https://git.company.com'
    );
    expect(result).toMatchObject({
      platform: 'gitlab',
      owner: 'team',
      repo: 'project',
      gitlabBaseUrl: 'https://git.company.com'
    });
  });

  it('returns null for a self-hosted URL when base URL does not match', () => {
    const result = parseRepoFromUrl(
      'https://git.other.com/team/project',
      'https://git.company.com'
    );
    expect(result).toBeNull();
  });
});

describe('parseRepoFromUrl — invalid URLs', () => {
  it('returns null for an empty string', () => {
    expect(parseRepoFromUrl('')).toBeNull();
  });

  it('returns null for a non-VCS URL', () => {
    expect(parseRepoFromUrl('https://example.com/foo/bar')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseRepoFromUrl('not-a-url')).toBeNull();
  });
});
