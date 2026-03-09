import type { ApiEndpoint, RepoFile } from '@shared/types';
import { parseCodeRoutes } from './codeRouteParser';
import { parseOpenApiSpecs } from './openApiParser';

export const parseApiMap = (files: RepoFile[]): ApiEndpoint[] => {
  const codeEndpoints = parseCodeRoutes(files);
  const openApiEndpoints = parseOpenApiSpecs(files);

  const merged = [...openApiEndpoints, ...codeEndpoints];
  const deduped = new Map<string, ApiEndpoint>();

  for (const endpoint of merged) {
    const key = `${endpoint.method}:${endpoint.path}`;
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, endpoint);
      continue;
    }

    if (endpoint.source === 'openapi' && current.source !== 'openapi') {
      deduped.set(key, endpoint);
      continue;
    }

    if (current.source === 'openapi' && endpoint.source !== 'openapi') {
      continue;
    }

    if ((endpoint.confidence ?? 0) > (current.confidence ?? 0)) {
      deduped.set(key, endpoint);
    }
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.path === b.path) {
      return a.method.localeCompare(b.method);
    }
    return a.path.localeCompare(b.path);
  });
};
