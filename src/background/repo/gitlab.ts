import type { RepoFile, RepoRef } from '@shared/types';
import { withRetry } from '@background/utils/retry';
import { MAX_FILES, shouldExcludePath, sortCandidates, supportsPath } from './shared';
import { checkGitLabRateLimit } from './rateLimit';

interface GitLabTreeItem {
  id: string;
  path: string;
  type: 'blob' | 'tree';
}

const buildHeaders = (token?: string): HeadersInit => {
  if (!token) {
    return {};
  }
  return {
    'PRIVATE-TOKEN': token
  };
};

const normalizeBase = (value?: string): string => (value || 'https://gitlab.com').replace(/\/$/, '');

const fetchTreePage = async (url: string, headers: HeadersInit, signal?: AbortSignal): Promise<{ items: GitLabTreeItem[]; nextPage?: string | null }> => {
  const response = await fetch(url, { headers, signal });
  await checkGitLabRateLimit(response.headers);
  if (!response.ok) {
    throw new Error(`GitLab tree fetch failed: ${response.status}`);
  }

  return {
    items: (await response.json()) as GitLabTreeItem[],
    nextPage: response.headers.get('x-next-page')
  };
};

export const fetchGitLabRepoFiles = async (repo: RepoRef, token?: string, signal?: AbortSignal): Promise<RepoFile[]> => {
  const baseUrl = normalizeBase(repo.gitlabBaseUrl);
  const headers = buildHeaders(token);
  const projectId = encodeURIComponent(`${repo.owner}/${repo.repo}`);
  const ref = repo.branch ?? 'HEAD';

  const treeUrl = new URL(`${baseUrl}/api/v4/projects/${projectId}/repository/tree`);
  treeUrl.searchParams.set('ref', ref);
  treeUrl.searchParams.set('recursive', 'true');
  treeUrl.searchParams.set('per_page', '100');
  if (repo.path) {
    treeUrl.searchParams.set('path', repo.path);
  }

  const tree: GitLabTreeItem[] = [];
  let page = '1';

  while (page) {
    treeUrl.searchParams.set('page', page);
    const result = await withRetry(async () => await fetchTreePage(treeUrl.toString(), headers, signal));
    tree.push(...result.items);
    page = result.nextPage || '';
  }

  const candidateFiles = sortCandidates(
    tree.filter((item) => item.type === 'blob' && supportsPath(item.path) && !shouldExcludePath(item.path))
  ).slice(0, MAX_FILES);

  const CONCURRENCY = 15;
  const files: RepoFile[] = [];

  for (let i = 0; i < candidateFiles.length; i += CONCURRENCY) {
    const batch = candidateFiles.slice(i, i + CONCURRENCY);
    let lastResponseHeaders: Headers | null = null;
    const batchResults = await Promise.all(
      batch.map(async (item): Promise<RepoFile> => {
        const fileUrl = `${baseUrl}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(item.path)}/raw?ref=${encodeURIComponent(ref)}`;
        const content = await withRetry(async () => {
          const response = await fetch(fileUrl, { headers, signal });
          await checkGitLabRateLimit(response.headers); // Added rate limit check
          if (!response.ok) {
            throw new Error(`GitLab file fetch failed: ${response.status}`);
          }
          lastResponseHeaders = response.headers;
          return response.text();
        });

        return {
          path: item.path,
          sha: item.id, // Kept sha and size for RepoFile type consistency
          content,
          size: content.length
        };
      })
    );
    if (lastResponseHeaders) {
      await checkGitLabRateLimit(lastResponseHeaders); // Added rate limit check after batch
    }
    files.push(...batchResults);
  }

  return files;
};
