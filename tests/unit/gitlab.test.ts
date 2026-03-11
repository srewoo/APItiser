import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitLabRepoFiles } from '@background/repo/gitlab';
import type { RepoRef } from '@shared/types';

const repo: RepoRef = { platform: 'gitlab', owner: 'acme', repo: 'my-api' };

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockHandler = (url: string) => { ok: boolean; status: number; text?: () => Promise<string>; json?: () => Promise<unknown>; headers?: Headers };

const makeFetch = (handler: MockHandler) =>
  vi.fn((url: string, _init?: RequestInit) => {
    const result = handler(url);
    const headers = result.headers ?? new Headers({ 'x-next-page': '' });
    return Promise.resolve({
      ok: result.ok,
      status: result.status,
      headers,
      json: result.json ?? (async () => ({})),
      text: result.text ?? (async () => ''),
    });
  });

const treeResponse = (items: unknown[], nextPage = '') =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'x-next-page': nextPage }),
    json: async () => items
  });

const fileResponse = (content: string) => ({
  ok: true,
  status: 200,
  text: async () => content
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('fetchGitLabRepoFiles', () => {
  it('fetches tree and file contents from GitLab', async () => {
    const fetchMock = makeFetch((url) => {
      if (url.includes('/repository/tree')) {
        return treeResponse([{ id: 'sha1', path: 'src/routes/users.ts', type: 'blob' }]);
      }
      if (url.includes('/repository/files/')) {
        return fileResponse('export const router = express.Router();');
      }
      return { ok: false, status: 404 };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitLabRepoFiles(repo);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/routes/users.ts');
    expect(files[0]!.content).toContain('express');
  });

  it('paginates through multiple tree pages', async () => {
    let page = 0;
    const fetchMock = makeFetch((url) => {
      if (url.includes('/repository/tree')) {
        page++;
        if (page === 1) {
          return treeResponse(
            [{ id: 'sha1', path: 'src/routes/users.ts', type: 'blob' }],
            '2' // next page
          );
        }
        return treeResponse([{ id: 'sha2', path: 'src/routes/posts.ts', type: 'blob' }]);
      }
      if (url.includes('/repository/files/')) {
        return fileResponse('// route');
      }
      return { ok: false, status: 404 };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitLabRepoFiles(repo);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/routes/users.ts');
    expect(paths).toContain('src/routes/posts.ts');
  });

  it('excludes files from excluded directories (e.g. node_modules)', async () => {
    const fetchMock = makeFetch((url) => {
      if (url.includes('/repository/tree')) {
        return treeResponse([
          { id: 'sha1', path: 'node_modules/lodash/index.js', type: 'blob' },
          { id: 'sha2', path: 'src/routes/users.ts', type: 'blob' }
        ]);
      }
      if (url.includes('/repository/files/')) {
        return fileResponse('// route');
      }
      return { ok: false, status: 404 };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitLabRepoFiles(repo);
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths).toContain('src/routes/users.ts');
  });

  it('skips unsupported file extensions', async () => {
    const fetchMock = makeFetch((url) => {
      if (url.includes('/repository/tree')) {
        return treeResponse([
          { id: 'sha1', path: 'README.md', type: 'blob' },
          { id: 'sha2', path: 'src/app.ts', type: 'blob' }
        ]);
      }
      if (url.includes('/repository/files/')) {
        return fileResponse('// ts');
      }
      return { ok: false, status: 404 };
    });

    vi.stubGlobal('fetch', fetchMock);

    const files = await fetchGitLabRepoFiles(repo);
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('.md'))).toBe(false);
    expect(paths).toContain('src/app.ts');
  });

  it('uses the provided GitLab token in PRIVATE-TOKEN header', async () => {
    const capturedHeaders: HeadersInit[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      capturedHeaders.push(init?.headers ?? {});
      if (url.includes('/repository/tree')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'x-next-page': '' }),
          json: async () => [],
          text: async () => ''
        });
      }
      return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    await fetchGitLabRepoFiles(repo, 'glpat-mytoken');

    const anyHeaderHasToken = capturedHeaders.some((h) => {
      const raw = h as Record<string, string>;
      return raw['PRIVATE-TOKEN'] === 'glpat-mytoken';
    });
    expect(anyHeaderHasToken).toBe(true);
  });

  it('queries the selected branch when listing the tree and fetching files', async () => {
    const branchRepo: RepoRef = { ...repo, branch: 'feature/login-hardening' };
    const requestedUrls: string[] = [];
    const fetchMock = makeFetch((url) => {
      requestedUrls.push(url);
      if (url.includes('/repository/tree')) {
        return treeResponse([{ id: 'sha1', path: 'src/routes/users.ts', type: 'blob' }]);
      }
      if (url.includes('/repository/files/')) {
        return fileResponse('// route');
      }
      return { ok: false, status: 404 };
    });

    vi.stubGlobal('fetch', fetchMock);

    await fetchGitLabRepoFiles(branchRepo);

    expect(requestedUrls.some((url) => url.includes('/repository/tree') && url.includes('ref=feature%2Flogin-hardening'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/repository/files/') && url.includes('ref=feature%2Flogin-hardening'))).toBe(true);
  });

  it('returns an empty list when the tree API fails', async () => {
    const fetchMock = makeFetch(() => ({ ok: false, status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    // withRetry will throw after retries; fetchGitLabRepoFiles should propagate
    await expect(fetchGitLabRepoFiles(repo)).rejects.toThrow();
  });
});
