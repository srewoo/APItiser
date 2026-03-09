import type { RepoRef } from '@shared/types';

const githubRegex = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?/i;
const gitlabRegex = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)(?:\/-\/tree\/([^/]+)(?:\/(.*))?)?/i;

const stripGit = (value: string): string => value.replace(/\.git$/i, '').trim();

export const parseRepoFromUrl = (url: string, gitlabBaseUrl = 'https://gitlab.com'): RepoRef | null => {
  const githubMatch = url.match(githubRegex);
  if (githubMatch) {
    return {
      platform: 'github',
      owner: githubMatch[1],
      repo: stripGit(githubMatch[2]),
      branch: githubMatch[3],
      path: githubMatch[4]
    };
  }

  const parsed = new URL(url);
  const gitlabHost = new URL(gitlabBaseUrl).host;

  if (parsed.host === gitlabHost) {
    const gitlabMatch = url.match(gitlabRegex);
    if (gitlabMatch) {
      return {
        platform: 'gitlab',
        owner: gitlabMatch[2],
        repo: stripGit(gitlabMatch[3]),
        branch: gitlabMatch[4],
        path: gitlabMatch[5],
        gitlabBaseUrl
      };
    }
  }

  return null;
};
