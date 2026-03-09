import type { RepoRef } from './types';

const githubRegex = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?/i;

export const parseRepoFromUrl = (url: string, gitlabBaseUrl = 'https://gitlab.com'): RepoRef | null => {
  const githubMatch = url.match(githubRegex);
  if (githubMatch) {
    return {
      platform: 'github',
      owner: githubMatch[1],
      repo: githubMatch[2].replace(/\.git$/i, ''),
      branch: githubMatch[3],
      path: githubMatch[4]
    };
  }

  try {
    const base = new URL(gitlabBaseUrl);
    const parsed = new URL(url);
    if (parsed.host !== base.host) {
      return null;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    const markerIndex = segments.findIndex((segment) => segment === '-');
    const repoParts = markerIndex === -1 ? segments : segments.slice(0, markerIndex);
    if (repoParts.length < 2) {
      return null;
    }

    const repo = repoParts[repoParts.length - 1].replace(/\.git$/i, '');
    const owner = repoParts.slice(0, -1).join('/');

    let branch: string | undefined;
    let path: string | undefined;
    if (markerIndex > -1 && segments[markerIndex + 1] === 'tree') {
      branch = segments[markerIndex + 2];
      path = segments.slice(markerIndex + 3).join('/') || undefined;
    }

    return {
      platform: 'gitlab',
      owner,
      repo,
      branch,
      path,
      gitlabBaseUrl
    };
  } catch {
    return null;
  }
};
