/**
 * What to tell the native host when the user presses Start: which repo (so it can find the
 * user's clone or make one) and where in it the API lives (from the scan's route evidence).
 */
import type { ApiEndpoint, RepoRef } from '@shared/types';
import type { BootRepo } from './localRunner';

export const bootRepoFor = (repo: RepoRef, gitlabBaseUrl?: string): BootRepo => {
  const base = repo.platform === 'gitlab' ? (repo.gitlabBaseUrl || gitlabBaseUrl || 'https://gitlab.com') : 'https://github.com';
  const origin = base.replace(/\/+$/, '');
  const host = new URL(origin).host;
  return {
    slug: `${host}/${repo.owner}/${repo.repo}`.toLowerCase(),
    cloneUrl: `${origin}/${repo.owner}/${repo.repo}.git`,
    platform: repo.platform
  };
};

// Spec files (openapi.yaml under docs/) say nothing about where the server code lives.
const SPEC_SOURCES = new Set<ApiEndpoint['source']>(['openapi']);

/**
 * The repo-relative folder holding the scanned routes: their common parent, or — when routes
 * span several top-level folders — the top-level folder holding most of them. Undefined when
 * there's no code evidence (the host then falls back to its own detection).
 */
export const apiDirHint = (endpoints: ApiEndpoint[]): string | undefined => {
  const dirs = endpoints
    .filter((endpoint) => !SPEC_SOURCES.has(endpoint.source))
    .map((endpoint) => endpoint.evidence?.[0]?.filePath)
    .filter((file): file is string => Boolean(file))
    .map((file) => file.split('/').slice(0, -1));
  if (!dirs.length) return undefined;

  const common: string[] = [];
  for (let i = 0; dirs.every((parts) => i < parts.length && parts[i] === dirs[0][i]); i += 1) {
    common.push(dirs[0][i]);
  }
  if (common.length) return common.join('/');

  const counts = new Map<string, number>();
  for (const parts of dirs) {
    if (parts[0]) counts.set(parts[0], (counts.get(parts[0]) ?? 0) + 1);
  }
  const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return top && count && count * 2 >= dirs.length ? top : undefined;
};
