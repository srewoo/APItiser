import type { RepoFile } from '@shared/types';
import { joinPath, makeEvidence, normalizePath } from '../endpointBuilder';
import type { RouteSignal } from '../routeTypes';

const JAVA_FILE_REGEX = /\.java$/i;

const resolveSpringMethod = (annotation: string, methodMatch: RegExpMatchArray | null): string => {
  if (annotation === 'RequestMapping') {
    return methodMatch?.[1] ?? 'GET';
  }
  const mapping = annotation.replace('Mapping', '');
  const aliases: Record<string, string> = {
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Patch: 'PATCH',
    Delete: 'DELETE'
  };
  return aliases[mapping] ?? mapping.toUpperCase();
};

export const parseSpringRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!JAVA_FILE_REGEX.test(file.path)) {
      continue;
    }

    // Only treat @RequestMapping as a class-level prefix when it lacks a `method = RequestMethod.X` qualifier,
    // which indicates a method-level handler annotation rather than a controller prefix.
    const classPrefixMatch = file.content.match(/@RequestMapping\((?:value|path)?\s*=?\s*\{?\s*"([^"]+)"(?![^)]*RequestMethod\.)/);
    const classPrefix = classPrefixMatch ? normalizePath(classPrefixMatch[1]) : '';

    for (const match of file.content.matchAll(/@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\(([\s\S]*?)\)/g)) {
      const annotation = match[1];
      const annotationBody = match[2];
      const pathMatch = annotationBody.match(/(?:value|path)?\s*=?\s*\{?\s*"([^"]+)"/);
      const methodMatch = annotationBody.match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)/);

      if (annotation === 'RequestMapping' && !methodMatch) {
        continue;
      }

      const method = resolveSpringMethod(annotation, methodMatch);
      const methodPath = pathMatch?.[1] ?? '';

      routes.push({
        method: method.toUpperCase(),
        path: joinPath(classPrefix, methodPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')),
        source: 'spring',
        owner: 'controller',
        file,
        confidence: classPrefix ? 0.9 : 0.86,
        evidence: [makeEvidence(file, 'spring controller mapping', match.index ?? undefined)]
      });
    }
  }

  return routes;
};
