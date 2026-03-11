import type { RepoFile, RepoRef } from '@shared/types';
import { withRetry } from '@background/utils/retry';

const MAX_FILES = 1200;
const ALLOWED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.py'];
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__'
]);

interface GitLabTreeItem {
  id: string;
  path: string;
  type: 'blob' | 'tree';
}

const supportsPath = (path: string): boolean => ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension));
const shouldExcludePath = (path: string): boolean => path.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
const rankPath = (path: string): number => {
  let score = 0;
  const lower = path.toLowerCase();

  if (/(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(lower)) {
    score += 120;
  }
  if (/(^|\/)(routes?|controllers?|handlers?|endpoints?)(\/|$)/i.test(lower)) {
    score += 80;
  }
  if (/(^|\/)(api|apis|server|backend|services?|app)(\/|$)/i.test(lower)) {
    score += 50;
  }
  if (/(^|\/)(src|lib)(\/|$)/i.test(lower)) {
    score += 20;
  }
  if (/(^|\/)(tests?|__tests__)(\/|$)/i.test(lower)) {
    score += 10;
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(lower)) {
    score += 10;
  }

  return score;
};

const sortCandidates = <T extends { path: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => {
    const scoreDiff = rankPath(right.path) - rankPath(left.path);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.path.localeCompare(right.path);
  });

const buildHeaders = (token?: string): HeadersInit => {
  if (!token) {
    return {};
  }
  return {
    'PRIVATE-TOKEN': token
  };
};

const normalizeBase = (value?: string): string => (value || 'https://gitlab.com').replace(/\/$/, '');

const fetchTreePage = async (url: string, headers: HeadersInit): Promise<{ items: GitLabTreeItem[]; nextPage?: string | null }> => {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitLab tree fetch failed: ${response.status}`);
  }

  return {
    items: (await response.json()) as GitLabTreeItem[],
    nextPage: response.headers.get('x-next-page')
  };
};

export const fetchGitLabRepoFiles = async (repo: RepoRef, token?: string): Promise<RepoFile[]> => {
  const baseUrl = normalizeBase(repo.gitlabBaseUrl);
  const headers = buildHeaders(token);
  const projectId = encodeURIComponent(`${repo.owner}/${repo.repo}`);
  const ref = repo.branch ?? 'HEAD';

  const treeUrl = new URL(`${baseUrl}/api/v4/projects/${projectId}/repository/tree`);
  treeUrl.searchParams.set('recursive', 'true');
  treeUrl.searchParams.set('per_page', '100');
  if (repo.path) {
    treeUrl.searchParams.set('path', repo.path);
  }

  const tree: GitLabTreeItem[] = [];
  let page = '1';

  while (page) {
    treeUrl.searchParams.set('page', page);
    const result = await withRetry(async () => await fetchTreePage(treeUrl.toString(), headers));
    tree.push(...result.items);
    page = result.nextPage || '';
  }

  const candidates = sortCandidates(
    tree.filter((item) => item.type === 'blob' && supportsPath(item.path) && !shouldExcludePath(item.path))
  ).slice(0, MAX_FILES);

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
