import type { RepoFile, RepoRef } from '@shared/types';
import { withRetry } from '@background/utils/retry';
import { MAX_FILES, rankPath, shouldExcludePath, sortCandidates, supportsPath } from './shared';
import { checkGitHubRateLimit } from './rateLimit';

const normalizePath = (value?: string): string => (value ?? '').replace(/^\/+|\/+$/g, '');
const withinScope = (path: string, scope?: string): boolean => {
  const normalizedScope = normalizePath(scope);
  if (!normalizedScope) {
    return true;
  }
  return path === normalizedScope || path.startsWith(`${normalizedScope}/`);
};

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
  truncated?: boolean;
}

interface GitHubBlobResponse {
  content: string;
  encoding: 'base64';
  size: number;
}

interface GitHubContentsItem {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  sha: string;
  size: number;
  download_url: string | null;
}

const decodeBase64 = (content: string): string => {
  const cleaned = content.replace(/\n/g, '');
  const binaryStr = atob(cleaned);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
};

/**
 * Fallback for large repos where the recursive tree API returns `truncated: true`.
 * Uses the Contents API to enumerate files in the highest-scored directories up to
 * MAX_CONTENTS_DEPTH levels deep, collecting blobs that pass the standard filters.
 */
const MAX_CONTENTS_DEPTH = 2;
const CONTENTS_SCORE_THRESHOLD = 20; // must be ≥ this to recurse a sub-directory

const fetchGitHubFilesViaContents = async (
  repo: RepoRef,
  token: string | undefined,
  headers: HeadersInit,
  partialTree: GitHubTreeItem[],
  signal?: AbortSignal
): Promise<RepoFile[]> => {
  const branch = repo.branch ?? 'HEAD';
  const accumulated: RepoFile[] = [];
  const visited = new Set<string>();

  // Collect candidate directory paths from the partial tree results, scored by relevance.
  // Also always include the repo root ('') so we don't miss top-level source files.
  const rootDirs = new Set<string>(['']);

  for (const item of partialTree) {
    if (item.type === 'tree' && !shouldExcludePath(item.path)) {
      // Only keep direct children of root or of known high-score parent dirs.
      const depth = item.path.split('/').length;
      if (depth <= 2 && rankPath(item.path) >= CONTENTS_SCORE_THRESHOLD) {
        rootDirs.add(item.path);
      }
    }
  }

  const fetchDir = async (dirPath: string, depth: number): Promise<void> => {
    if (visited.has(dirPath) || accumulated.length >= MAX_FILES) {
      return;
    }
    visited.add(dirPath);

    const encodedPath = dirPath ? `/${encodeURIComponent(dirPath).replace(/%2F/g, '/')}` : '';
    const contentsUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents${encodedPath}?ref=${encodeURIComponent(branch)}`;

    let items: GitHubContentsItem[];
    try {
      const response = await withRetry(async () => {
        const res = await fetch(contentsUrl, { headers, signal });
        if (!res.ok) {
          throw new Error(`GitHub contents fetch failed (${dirPath}): ${res.status}`);
        }
        return res;
      });
      items = (await response.json()) as GitHubContentsItem[];
      if (!Array.isArray(items)) {
        return;
      }
    } catch {
      return; // Best-effort: skip directories we can't read.
    }

    const subDirs: GitHubContentsItem[] = [];

    for (const item of items) {
      if (accumulated.length >= MAX_FILES) {
        break;
      }

      if (item.type === 'file') {
        if (
          supportsPath(item.path) &&
          withinScope(item.path, repo.path) &&
          !shouldExcludePath(item.path) &&
          !visited.has(item.path)
        ) {
          visited.add(item.path);
          const blobUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/blobs/${item.sha}`;
          try {
            const blob = await withRetry(async () => {
              const res = await fetch(blobUrl, { headers, signal });
              if (!res.ok) {
                throw new Error(`GitHub blob fetch failed: ${res.status}`);
              }
              return (await res.json()) as GitHubBlobResponse;
            });
            accumulated.push({
              path: item.path,
              sha: item.sha,
              size: blob.size,
              content: decodeBase64(blob.content)
            });
          } catch {
            // Skip unreadable blobs.
          }
        }
      } else if (item.type === 'dir' && depth < MAX_CONTENTS_DEPTH && !shouldExcludePath(item.path)) {
        subDirs.push(item);
      }
    }

    // Recurse into sub-directories sorted by relevance score.
    const sortedSubDirs = sortCandidates(subDirs);
    for (const subDir of sortedSubDirs) {
      if (accumulated.length >= MAX_FILES) {
        break;
      }
      await fetchDir(subDir.path, depth + 1);
    }
  };

  // Explore root dirs in score order.
  const sortedRootDirs = [...rootDirs].sort((a, b) => rankPath(b) - rankPath(a));
  for (const dir of sortedRootDirs) {
    if (accumulated.length >= MAX_FILES) {
      break;
    }
    await fetchDir(dir, 0);
  }

  return sortCandidates(accumulated).slice(0, MAX_FILES);
};

export const fetchGitHubRepoFiles = async (
  repo: RepoRef,
  token?: string,
  signal?: AbortSignal
): Promise<RepoFile[]> => {
  const branch = repo.branch ?? 'HEAD';
  const headers = buildHeaders(token);

  const treeUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

  const treeJson = await withRetry(async () => {
    const response = await fetch(treeUrl, { headers, signal });
    if (!response.ok) {
      throw new Error(`GitHub tree fetch failed: ${response.status}`);
    }
    return (await response.json()) as GitHubTreeResponse;
  });

  // When the tree is truncated (>100 k items), fall back to the Contents API
  // so that the highest-scoring directories are still enumerated completely.
  if (treeJson.truncated) {
    console.warn(
      `[APItiser] GitHub tree truncated for ${repo.owner}/${repo.repo}. Falling back to Contents API.`
    );
    return fetchGitHubFilesViaContents(repo, token, headers, treeJson.tree, signal);
  }

  const candidateFiles = sortCandidates(
    treeJson.tree.filter(
      (item) =>
        item.type === 'blob' &&
        supportsPath(item.path) &&
        withinScope(item.path, repo.path) &&
        !shouldExcludePath(item.path)
    )
  ).slice(0, MAX_FILES);

  const CONCURRENCY = 15;
  const files: RepoFile[] = [];

  for (let i = 0; i < candidateFiles.length; i += CONCURRENCY) {
    const batch = candidateFiles.slice(i, i + CONCURRENCY);
    let lastResponseHeaders: Headers | null = null;
    const batchResults = await Promise.all(
      batch.map(async (item): Promise<RepoFile> => {
        const blobUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/blobs/${item.sha}`;
        const blob = await withRetry(async () => {
          const response = await fetch(blobUrl, { headers, signal });
          if (!response.ok) {
            throw new Error(`GitHub blob fetch failed: ${response.status}`);
          }
          lastResponseHeaders = response.headers;
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
    // Check rate limit after each batch and sleep if exhausted
    if (lastResponseHeaders) {
      await checkGitHubRateLimit(lastResponseHeaders);
    }
    files.push(...batchResults);
  }

  return files;
};
