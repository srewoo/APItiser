import type { ApiEndpoint, RepoFile } from '@shared/types';
import { buildEndpoint, joinPath, makeEvidence } from '../endpointBuilder';

/**
 * PHP route detection for the two dominant frameworks:
 *  - Laravel: `Route::get('/path', …)`, `Route::apiResource('things', …)`, and
 *    `Route::prefix('api')->group(…)` / `Route::group(['prefix' => 'api'], …)` nesting.
 *  - Symfony: `#[Route('/path', methods: ['GET'])]` PHP 8 attributes and legacy
 *    `@Route("/path", methods={"GET"})` annotations, with a class-level `#[Route('/prefix')]`
 *    applied to every action in the controller.
 *
 * Line/attribute scanner — resilient and never throws; unknown shapes are skipped.
 */

const LARAVEL_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options'];

const looksLikeLaravel = (file: RepoFile): boolean => /\bRoute::/.test(file.content);
const looksLikeSymfony = (file: RepoFile): boolean => /#\[\s*Route\s*\(/.test(file.content) || /@Route\s*\(/.test(file.content);

const parseMethodsList = (rest: string): string[] => {
  const arr = /methods\s*[:=]\s*[[{]([^\]}]*)[\]}]/.exec(rest);
  const single = /methods\s*[:=]\s*['"]([^'"]+)['"]/.exec(rest);
  const raw = arr ? arr[1] : single ? single[1] : '';
  const verbs = [...raw.matchAll(/['"]([A-Za-z]+)['"]/g)].map((m) => m[1].toUpperCase());
  return verbs.length ? verbs : ['GET'];
};

// ---- Laravel -------------------------------------------------------------

const expandLaravelResource = (
  name: string,
  prefix: string,
  file: RepoFile,
  push: (method: string, path: string, note: string) => void
): void => {
  const base = joinPath(prefix, name);
  const singular = name.replace(/s$/, '');
  const idPath = joinPath(base, `{${singular}}`);
  push('GET', base, `apiResource ${name}`);
  push('POST', base, `apiResource ${name}`);
  push('GET', idPath, `apiResource ${name}`);
  push('PUT', idPath, `apiResource ${name}`);
  push('DELETE', idPath, `apiResource ${name}`);
};

const parseLaravel = (file: RepoFile): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();
  const stack: Array<{ prefix: string; depth: number }> = [];
  const currentPrefix = (): string => stack.reduce((acc, frame) => joinPath(acc, frame.prefix || '/'), '/');

  const push = (method: string, path: string, note: string): void => {
    const normalized = path || '/';
    const key = `${method} ${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(
      buildEndpoint({
        method,
        path: normalized,
        source: 'laravel',
        file,
        summary: `${method} ${normalized}`,
        description: `Laravel route (${note})`,
        confidence: 0.8,
        evidence: [makeEvidence(file, `Laravel ${note}`, file.content.indexOf(note.split(' ')[0]))]
      })
    );
  };

  let depth = 0;
  for (const line of file.content.split('\n')) {
    const prefix = currentPrefix();

    // Verb routes: Route::get('/path', ...)
    for (const verb of LARAVEL_VERBS) {
      const re = new RegExp(`Route::${verb}\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
      for (const m of line.matchAll(re)) {
        push(verb.toUpperCase(), joinPath(prefix, m[1]), `Route::${verb}`);
      }
    }
    // Route::any / Route::match
    for (const m of line.matchAll(/Route::any\s*\(\s*['"]([^'"]+)['"]/g)) {
      push('GET', joinPath(prefix, m[1]), 'Route::any');
    }
    for (const m of line.matchAll(/Route::match\s*\(\s*\[([^\]]*)\]\s*,\s*['"]([^'"]+)['"]/g)) {
      for (const verb of [...m[1].matchAll(/['"]([A-Za-z]+)['"]/g)]) {
        push(verb[1].toUpperCase(), joinPath(prefix, m[2]), 'Route::match');
      }
    }
    // apiResource / resource
    for (const m of line.matchAll(/Route::(?:api)?[Rr]esource\s*\(\s*['"]([^'"]+)['"]/g)) {
      expandLaravelResource(m[1], prefix, file, push);
    }

    // Group opening on this line?
    const opensGroup = /->group\s*\(|Route::group\s*\(/.test(line);
    let groupPrefix = '';
    if (opensGroup) {
      // `Route::prefix('api')` (static) or a chained `->prefix('api')`, or the array form.
      const chained = /(?:->|::)prefix\s*\(\s*['"]([^'"]+)['"]/.exec(line);
      const arrayForm = /['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/.exec(line);
      groupPrefix = chained ? chained[1] : arrayForm ? arrayForm[1] : '';
    }

    // Track brace depth across the line.
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
      }
    }
    if (opensGroup) stack.push({ prefix: groupPrefix, depth });
  }

  return endpoints;
};

// ---- Symfony -------------------------------------------------------------

const lineOf = (content: string, index: number): number => content.slice(0, index).split('\n').length;

interface RouteDecl {
  path: string;
  args: string;
  index: number;
}

/** All `#[Route(...)]` attributes and `@Route(...)` annotations, args captured whole. */
const collectRouteDecls = (content: string): RouteDecl[] => {
  const decls: RouteDecl[] = [];
  const patterns = [/#\[\s*Route\s*\(([\s\S]*?)\)\s*\]/g, /@Route\s*\(([\s\S]*?)\)/g];
  for (const pattern of patterns) {
    for (const m of content.matchAll(pattern)) {
      const args = m[1];
      const pathMatch = /['"]([^'"]*)['"]/.exec(args);
      if (!pathMatch) continue;
      decls.push({ path: pathMatch[1], args, index: m.index ?? 0 });
    }
  }
  return decls;
};

const findClassPrefix = (content: string, decls: RouteDecl[]): string => {
  const classMatch = /\bclass\s+\w+/.exec(content);
  if (!classMatch) return '';
  const classLine = lineOf(content, classMatch.index);
  // The class-level Route is the attribute/annotation without `methods` sitting just above `class`.
  for (const decl of decls) {
    const declLine = lineOf(content, decl.index);
    if (declLine < classLine && classLine - declLine <= 4 && !/methods/.test(decl.args)) {
      return decl.path;
    }
  }
  return '';
};

const parseSymfony = (file: RepoFile): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();
  const decls = collectRouteDecls(file.content);
  const classPrefix = findClassPrefix(file.content, decls);
  const classMatch = /\bclass\s+\w+/.exec(file.content);
  const classIndex = classMatch ? classMatch.index : -1;

  const push = (method: string, path: string, index: number): void => {
    const full = joinPath(classPrefix, path);
    const key = `${method} ${full}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(
      buildEndpoint({
        method,
        path: full,
        source: 'symfony',
        file,
        summary: `${method} ${full}`,
        description: 'Symfony route attribute/annotation',
        confidence: 0.8,
        evidence: [makeEvidence(file, 'Symfony #[Route]', index)]
      })
    );
  };

  for (const decl of decls) {
    // Skip the class-level prefix declaration itself.
    if (classIndex >= 0 && decl.index < classIndex && decl.path === classPrefix && !/methods/.test(decl.args)) continue;
    for (const method of parseMethodsList(decl.args)) {
      push(method, decl.path, decl.index);
    }
  }

  return endpoints;
};

export const parsePhpEndpoints = (files: RepoFile[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  for (const file of files) {
    if (!/\.php$/i.test(file.path)) continue;
    if (looksLikeLaravel(file)) endpoints.push(...parseLaravel(file));
    if (looksLikeSymfony(file)) endpoints.push(...parseSymfony(file));
  }
  return endpoints;
};
