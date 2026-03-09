import type { RepoRef, RepoValidationResult } from '@shared/types';

const normalizeBase = (value?: string): string => (value || 'https://gitlab.com').replace(/\/$/, '');

const decodeStatus = (status: number): string => {
  if (status === 401 || status === 403) {
    return 'Authentication failed or insufficient token scope.';
  }
  if (status === 404) {
    return 'Repository or endpoint not found for supplied host/repo.';
  }
  return `Request failed with HTTP ${status}.`;
};

export const validateRepoAccess = async (
  repo: RepoRef,
  tokens: { githubToken?: string; gitlabToken?: string }
): Promise<RepoValidationResult> => {
  const checks: RepoValidationResult['checks'] = [];

  if (repo.platform === 'github') {
    const headers: HeadersInit = { Accept: 'application/vnd.github+json' };
    if (tokens.githubToken) {
      headers.Authorization = `Bearer ${tokens.githubToken}`;
    } else {
      checks.push({
        name: 'GitHub token',
        status: 'warn',
        detail: 'No GitHub token configured. Public repositories only.'
      });
    }

    const repoUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
    const repoResponse = await fetch(repoUrl, { headers });

    if (repoResponse.ok) {
      checks.push({
        name: 'GitHub repository access',
        status: 'ok',
        detail: 'Repository API is reachable and accessible.'
      });
    } else {
      checks.push({
        name: 'GitHub repository access',
        status: 'error',
        detail: decodeStatus(repoResponse.status)
      });
    }

    if (tokens.githubToken) {
      const userResponse = await fetch('https://api.github.com/user', { headers });
      checks.push({
        name: 'GitHub token validity',
        status: userResponse.ok ? 'ok' : 'error',
        detail: userResponse.ok ? 'Token is valid.' : decodeStatus(userResponse.status)
      });
    }
  } else {
    const baseUrl = normalizeBase(repo.gitlabBaseUrl);
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:') {
        checks.push({
          name: 'GitLab base URL protocol',
          status: 'error',
          detail: 'Only HTTPS GitLab base URLs are allowed.'
        });
        return { ok: false, checkedAt: Date.now(), checks };
      }
    } catch {
      checks.push({
        name: 'GitLab base URL format',
        status: 'error',
        detail: 'Invalid GitLab base URL format.'
      });
      return { ok: false, checkedAt: Date.now(), checks };
    }

    const headers: HeadersInit = tokens.gitlabToken ? { 'PRIVATE-TOKEN': tokens.gitlabToken } : {};

    const versionResponse = await fetch(`${baseUrl}/api/v4/version`, { headers });
    checks.push({
      name: 'GitLab host reachability',
      status: versionResponse.ok ? 'ok' : 'error',
      detail: versionResponse.ok ? 'GitLab API is reachable.' : decodeStatus(versionResponse.status)
    });

    if (!tokens.gitlabToken) {
      checks.push({
        name: 'GitLab token',
        status: 'warn',
        detail: 'No GitLab token configured. Private projects may fail.'
      });
    }

    const projectId = encodeURIComponent(`${repo.owner}/${repo.repo}`);
    const projectResponse = await fetch(`${baseUrl}/api/v4/projects/${projectId}`, { headers });
    checks.push({
      name: 'GitLab repository access',
      status: projectResponse.ok ? 'ok' : 'error',
      detail: projectResponse.ok ? 'Project API is reachable and accessible.' : decodeStatus(projectResponse.status)
    });
  }

  return {
    ok: checks.every((check) => check.status !== 'error'),
    checkedAt: Date.now(),
    checks
  };
};
