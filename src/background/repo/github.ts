import type { RepoFile, RepoRef } from '@shared/types';
import { withRetry } from '@background/utils/retry';

const MAX_FILES = 250;
const ALLOWED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.yaml', '.yml'];

const supportsPath = (path: string): boolean => ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension));

const buildHeaders = (token?: string): HeadersInit => {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github+json'
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
};

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'tree' | 'blob';
  sha: string;
  size?: number;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
}

interface GitHubBlobResponse {
  content: string;
  encoding: 'base64';
  size: number;
}

const decodeBase64 = (content: string): string => atob(content.replace(/\n/g, ''));

export const fetchGitHubRepoFiles = async (repo: RepoRef, token?: string): Promise<RepoFile[]> => {
  const branch = repo.branch ?? 'HEAD';
  const headers = buildHeaders(token);

  const treeUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

  const treeJson = await withRetry(async () => {
    const response = await fetch(treeUrl, { headers });
    if (!response.ok) {
      throw new Error(`GitHub tree fetch failed: ${response.status}`);
    }
    return (await response.json()) as GitHubTreeResponse;
  });

  const candidateFiles = treeJson.tree
    .filter((item) => item.type === 'blob' && supportsPath(item.path))
    .slice(0, MAX_FILES);

  const files = await Promise.all(
    candidateFiles.map(async (item): Promise<RepoFile> => {
      const blobUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/blobs/${item.sha}`;
      const blob = await withRetry(async () => {
        const response = await fetch(blobUrl, { headers });
        if (!response.ok) {
          throw new Error(`GitHub blob fetch failed: ${response.status}`);
        }
        return (await response.json()) as GitHubBlobResponse;
      });

      return {
        path: item.path,
        sha: item.sha,
        size: blob.size,
        content: decodeBase64(blob.content)
      };
    })
  );

  return files;
};
