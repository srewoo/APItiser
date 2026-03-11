/**
 * Shared utilities for GitHub and GitLab repository scanners.
 * Centralises constants and path-scoring logic used by both scanners.
 */

export const MAX_FILES = 1200;

export const ALLOWED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.py'];

export const EXCLUDED_SEGMENTS = new Set([
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

/** Returns true if the file extension is supported for API parsing. */
export const supportsPath = (path: string): boolean =>
  ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension));

/** Returns true if any path segment is in the excluded set. */
export const shouldExcludePath = (path: string): boolean =>
  path.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));

/**
 * Scores a file/directory path by relevance to API route detection.
 * Higher score = more likely to contain API routes.
 */
// eslint-disable-next-line no-useless-escape
export const rankPath = (path: string): number => {
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

/** Sorts items by descending relevance score, then alphabetically. */
export const sortCandidates = <T extends { path: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => {
    const scoreDiff = rankPath(right.path) - rankPath(left.path);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.path.localeCompare(right.path);
  });
