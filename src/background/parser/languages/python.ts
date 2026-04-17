import type { RepoFile } from '@shared/types';
import { makeEvidence, normalizePath } from '../endpointBuilder';
import type { RouteSignal } from '../routeTypes';

const PY_FILE_REGEX = /\.py$/i;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

export const parsePythonRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!PY_FILE_REGEX.test(file.path)) {
      continue;
    }

    const isFastApi = /from\s+fastapi\s+import|FastAPI\s*\(/i.test(file.content);
    const source = isFastApi ? 'fastapi' : ('flask' as const);

    for (const match of file.content.matchAll(/@(\w+)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/gim)) {
      const method = match[2].toUpperCase();
      const path = normalizePath(match[3].replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'));
      routes.push({
        method,
        path,
        source,
        owner: match[1],
        file,
        confidence: 0.92,
        evidence: [makeEvidence(file, `${source} decorator route`, match.index ?? undefined)]
      });
    }

    for (const match of file.content.matchAll(/@(\w+)\.route\(\s*["']([^"']+)["'][^)]*methods\s*=\s*\[([^\]]+)\]/gim)) {
      const methodTokens = match[3].match(/["']([A-Za-z]+)["']/gim) ?? [];
      const methods = methodTokens
        .map((token) => token.replace(/["']/g, '').toUpperCase())
        .filter((method) => HTTP_METHODS.has(method));
      for (const method of methods) {
        routes.push({
          method,
          path: normalizePath(match[2].replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')),
          source: 'flask',
          owner: match[1],
          file,
          confidence: 0.9,
          evidence: [makeEvidence(file, 'flask @route methods declaration', match.index ?? undefined)]
        });
      }
    }
  }

  return routes;
};
