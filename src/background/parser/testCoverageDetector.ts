import type { ApiEndpoint, RepoFile } from '@shared/types';

const defaultTestFilePattern = /(?:\.test|\.spec)\.(?:[jt]sx?|mjs|cjs|py)$/i;

const normalizeDir = (value: string): string => value.trim().replace(/^\/+|\/+$/g, '');

const toPathPattern = (path: string): RegExp => {
  const escaped = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+/g, '[^/\\s"\'`]+')
    .replace(/\{[^}]+\}/g, '[^/\\s"\'`]+');

  return new RegExp(escaped, 'i');
};

const endpointStaticSegments = (path: string): string[] =>
  path
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .filter((segment) => !segment.startsWith(':') && !/^\{[^}]+\}$/.test(segment));

const hasStaticPathHints = (contentLower: string, path: string): boolean => {
  const segments = endpointStaticSegments(path);
  if (!segments.length) {
    return false;
  }

  const candidateSegments = segments.filter((segment) => segment.length >= 3);
  const required = candidateSegments.length >= 2 ? candidateSegments : segments;
  return required.every((segment) => contentLower.includes(`/${segment}`));
};

const isLikelyTestFile = (path: string, dirs: string[]): boolean => {
  const normalizedPath = path.replace(/^\/+/, '');
  const segments = normalizedPath.split('/');

  if (defaultTestFilePattern.test(path)) {
    return true;
  }

  return dirs.some((dir) => {
    const normalizedDir = normalizeDir(dir);
    return normalizedDir ? segments.includes(normalizedDir) : false;
  });
};

export const detectExistingTestCoverage = (
  files: RepoFile[],
  endpoints: ApiEndpoint[],
  testDirectories: string[]
): string[] => {
  const testFiles = files.filter((file) => isLikelyTestFile(file.path, testDirectories));
  const covered = new Set<string>();

  for (const endpoint of endpoints) {
    const methodToken = endpoint.method.toLowerCase();
    const methodMatcher = new RegExp(
      String.raw`(?:\.\s*${methodToken}\s*\(|method\s*:\s*["'\`]${methodToken}["'\`]|request\s*\([^)]*["'\`]${methodToken}["'\`])`,
      'i'
    );
    const pathRegex = toPathPattern(endpoint.path);

    for (const file of testFiles) {
      const lower = file.content.toLowerCase();
      const methodHit = methodMatcher.test(lower);

      if (!methodHit) {
        continue;
      }

      if (pathRegex.test(file.content) || hasStaticPathHints(lower, endpoint.path)) {
        covered.add(endpoint.id);
        break;
      }
    }
  }

  return [...covered];
};
