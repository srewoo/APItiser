import type { RepoFile, RepoRef } from '@shared/types';
import { withRetry } from '@background/utils/retry';

const MAX_FILES = 250;
const ALLOWED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.yaml', '.yml'];

interface GitLabTreeItem {
  id: string;
  path: string;
  type: 'blob' | 'tree';
}

const supportsPath = (path: string): boolean => ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension));

const buildHeaders = (token?: string): HeadersInit => {
  if (!token) {
    return {};
  }
  return {
    'PRIVATE-TOKEN': token
  };
};

const normalizeBase = (value?: string): string => (value || 'https://gitlab.com').replace(/\/$/, '');

export const fetchGitLabRepoFiles = async (repo: RepoRef, token?: string): Promise<RepoFile[]> => {
  const baseUrl = normalizeBase(repo.gitlabBaseUrl);
  const headers = buildHeaders(token);
  const projectId = encodeURIComponent(`${repo.owner}/${repo.repo}`);
  const ref = repo.branch ?? 'HEAD';

  const treeUrl = `${baseUrl}/api/v4/projects/${projectId}/repository/tree?recursive=true&per_page=100`;

  const tree = await withRetry(async () => {
    const response = await fetch(treeUrl, { headers });
    if (!response.ok) {
      throw new Error(`GitLab tree fetch failed: ${response.status}`);
    }
    return (await response.json()) as GitLabTreeItem[];
  });

  const candidates = tree
    .filter((item) => item.type === 'blob' && supportsPath(item.path))
    .slice(0, MAX_FILES);

  const files = await Promise.all(
    candidates.map(async (item): Promise<RepoFile> => {
      const fileUrl = `${baseUrl}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(item.path)}/raw?ref=${encodeURIComponent(ref)}`;
      const content = await withRetry(async () => {
        const response = await fetch(fileUrl, { headers });
        if (!response.ok) {
          throw new Error(`GitLab file fetch failed: ${response.status}`);
        }
        return await response.text();
      });

      return {
        path: item.path,
        sha: item.id,
        content,
        size: content.length
      };
    })
  );

  return files;
};
