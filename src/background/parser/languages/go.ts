import type { RepoFile } from '@shared/types';
import { joinPath, makeEvidence, normalizePath } from '../endpointBuilder';
import type { RouteSignal } from '../routeTypes';

const GO_FILE_REGEX = /\.go$/i;

export const parseGoRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!GO_FILE_REGEX.test(file.path)) {
      continue;
    }

    const groupPrefixes = new Map<string, string>();
    for (const match of file.content.matchAll(/\b(\w+)\s*:=\s*\w+\.Group\(\s*"([^"]+)"\s*\)/g)) {
      groupPrefixes.set(match[1], normalizePath(match[2]));
    }

    for (const match of file.content.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\(\s*"([^"]+)"/g)) {
      const owner = match[1];
      const prefix = groupPrefixes.get(owner) ?? '';
      routes.push({
        method: match[2].toUpperCase(),
        path: joinPath(prefix, match[3]),
        source: 'gin',
        owner,
        file,
        confidence: prefix ? 0.88 : 0.84,
        evidence: [makeEvidence(file, 'gin route registration', match.index ?? undefined)]
      });
    }
  }

  return routes;
};
