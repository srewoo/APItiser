import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubRepoFiles } from '@background/repo/github';
import type { RepoRef } from '@shared/types';

const repo: RepoRef = { platform: 'github', owner: 'acme', repo: 'big-repo' };

// ---------------------------------------------------------------------------
// Minimal fetch mock helpers
// ---------------------------------------------------------------------------

type FetchMockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

let fetchCallLog: string[] = [];

const makeFetch =
  (handler: (url: string) => FetchMockResponse) =>
    vi.fn((url: string) => Promise.resolve(handler(url)));

const treeBlob = (path: string, sha: string) => ({
  path,
  mode: '100644',
  type: 'blob' as const,
  sha,
  size: 100
});

const treeDir = (path: string) => ({
  path,
  mode: '040000',
  type: 'tree' as const,
  sha: 'dir-sha',
});

const contentsFile = (path: string, sha: string) => ({
  name: path.split('/').pop(),
  path,
  type: 'file' as const,
  sha,
  size: 100,
  download_url: null
});

const blobResponse = (content: string) =>
  ({ ok: true, status: 200, json: async () => ({ encoding: 'base64', content: btoa(content), size: content.length }) });

// ---------------------------------------------------------------------------

beforeEach(() => {
  fetchCallLog = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchGitHubRepoFiles — normal (non-truncated) tree', () => {
  it('fetches files from a complete tree without hitting the Contents API', async () => {
    const fetchMock = makeFetch((url) => {
      fetchCallLog.push(url);
      if (url.includes('/git/trees/')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            tree: [treeBlob('src/routes/users.ts', 'sha1')],
            truncated: false
          })
        };
      }
      if (url.includes('/git/blobs/')) {
        return blobResponse('export const router = express.Router();');
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitHubRepoFiles(repo);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/routes/users.ts');

    // Contents API must NOT have been called.
    const contentsCalls = fetchCallLog.filter((u) => u.includes('/contents'));
    expect(contentsCalls).toHaveLength(0);
  });
});

describe('fetchGitHubRepoFiles — truncated tree (large-repo fallback)', () => {
  it('switches to the Contents API when tree is truncated', async () => {
    const fetchMock = makeFetch((url) => {
      fetchCallLog.push(url);

      // Recursive tree — truncated with one partial directory hint.
      if (url.includes('/git/trees/')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            tree: [treeDir('routes')],
            truncated: true
          })
        };
      }

      // Contents API: root listing
      if (url.includes('/contents?ref=') || url.endsWith('/contents?ref=HEAD')) {
        return {
          ok: true, status: 200,
          json: async () => [contentsFile('index.ts', 'sha-index')]
        };
      }

      // Contents API: routes/ listing
      if (url.includes('/contents/routes')) {
        return {
          ok: true, status: 200,
          json: async () => [contentsFile('routes/users.ts', 'sha-users')]
        };
      }

      // Blob fetches
      if (url.includes('/git/blobs/')) {
        return blobResponse('// route');
      }

      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitHubRepoFiles(repo);
    // Should include files from root AND from routes/
    const paths = files.map((f) => f.path);
    expect(paths).toContain('index.ts');
    expect(paths).toContain('routes/users.ts');

    // Contents API must have been called.
    const contentsCalls = fetchCallLog.filter((u) => u.includes('/contents'));
    expect(contentsCalls.length).toBeGreaterThan(0);
  });

  it('excludes files from excluded directories even in fallback mode', async () => {
    const fetchMock = makeFetch((url) => {
      fetchCallLog.push(url);

      if (url.includes('/git/trees/')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            tree: [treeDir('node_modules'), treeDir('routes')],
            truncated: true
          })
        };
      }

      // Root listing — nothing interesting at root.
      if (url.match(/\/contents\?ref=/)) {
        return { ok: true, status: 200, json: async () => [] };
      }

      // node_modules listing — should not be fetched.
      if (url.includes('/contents/node_modules')) {
        return {
          ok: true, status: 200,
          json: async () => [contentsFile('node_modules/lodash/index.js', 'sha-lodash')]
        };
      }

      // routes/ listing.
      if (url.includes('/contents/routes')) {
        return {
          ok: true, status: 200,
          json: async () => [contentsFile('routes/health.ts', 'sha-health')]
        };
      }

      if (url.includes('/git/blobs/')) {
        return blobResponse('// file');
      }

      return { ok: false, status: 404, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitHubRepoFiles(repo);
    const paths = files.map((f) => f.path);

    // node_modules entries must not appear.
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    // routes/health.ts should appear (high-score dir).
    expect(paths).toContain('routes/health.ts');
  });

  it('returns an empty list gracefully when all Contents API calls fail', async () => {
    const fetchMock = makeFetch((url) => {
      if (url.includes('/git/trees/')) {
        return {
          ok: true, status: 200,
          json: async () => ({ tree: [treeDir('routes')], truncated: true })
        };
      }
      // All contents calls fail.
      return { ok: false, status: 503, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitHubRepoFiles(repo);
    expect(files).toHaveLength(0);
  });
});
