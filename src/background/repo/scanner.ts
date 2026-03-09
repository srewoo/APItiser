import type { RepoFile, RepoRef } from '@shared/types';
import { fetchGitHubRepoFiles } from './github';
import { fetchGitLabRepoFiles } from './gitlab';

export const scanRepositoryFiles = async (
  repo: RepoRef,
  tokens: { githubToken?: string; gitlabToken?: string }
): Promise<RepoFile[]> => {
  if (repo.platform === 'github') {
    return fetchGitHubRepoFiles(repo, tokens.githubToken);
  }

  return fetchGitLabRepoFiles(repo, tokens.gitlabToken);
};
