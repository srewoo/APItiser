import type { RepoFile, SchemaField } from '@shared/types';
import { joinPath, makeEvidence, normalizePath } from '../endpointBuilder';
import type { RouteSignal } from '../routeTypes';

const GO_FILE_REGEX = /\.go$/i;

type GoRouter = 'gin' | 'chi' | 'echo' | 'mux';

/**
 * Decide the primary mux-style router for a file from its imports. net/http
 * pattern routing (`mux.HandleFunc("GET /x", h)`) can coexist with any of these
 * and is always parsed in addition to the import-indicated router.
 */
const detectRouter = (content: string): GoRouter => {
  if (/github\.com\/go-chi\/chi/.test(content)) {
    return 'chi';
  }
  if (/github\.com\/labstack\/echo/.test(content)) {
    return 'echo';
  }
  if (/github\.com\/gorilla\/mux/.test(content)) {
    return 'mux';
  }
  // gin-gonic or no recognisable import -> default to gin (preserves legacy behaviour).
  return 'gin';
};

/**
 * Resolve a transitive chain of `child := parent.Group("/prefix")` declarations
 * into a flat groupVar -> fully-joined-prefix map. Works for Gin and echo, which
 * share the `.Group("/x")` shape.
 */
const buildGroupPrefixes = (content: string): Map<string, string> => {
  interface Node {
    parent?: string;
    prefix: string;
  }
  const nodes = new Map<string, Node>();
  // Capture both `v1 := api.Group("/v1")` and `v1 := r.Group("/api")`.
  for (const match of content.matchAll(/\b(\w+)\s*:=\s*(\w+)\.Group\(\s*"([^"]*)"/g)) {
    nodes.set(match[1], { parent: match[2], prefix: normalizePath(match[3]) });
  }

  const resolved = new Map<string, string>();
  const resolve = (name: string, seen: Set<string>): string => {
    if (resolved.has(name)) {
      return resolved.get(name) as string;
    }
    const node = nodes.get(name);
    if (!node || seen.has(name)) {
      return '';
    }
    seen.add(name);
    const parentPrefix = node.parent ? resolve(node.parent, seen) : '';
    const full = parentPrefix ? joinPath(parentPrefix, node.prefix) : node.prefix;
    resolved.set(name, full);
    return full;
  };

  for (const name of nodes.keys()) {
    resolve(name, new Set());
  }
  return resolved;
};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

// ---------------------------------------------------------------------------
// Gin (also covers the generic `r.GET("/x")` shape) + echo
// ---------------------------------------------------------------------------

const parseUppercaseMethodRoutes = (
  file: RepoFile,
  source: 'gin' | 'echo'
): RouteSignal[] => {
  const groupPrefixes = buildGroupPrefixes(file.content);
  const routes: RouteSignal[] = [];
  const methodAlt = HTTP_METHODS.join('|');
  const regex = new RegExp(`\\b(\\w+)\\.(${methodAlt})\\(\\s*"([^"]+)"`, 'g');
  for (const match of file.content.matchAll(regex)) {
    const owner = match[1];
    const prefix = groupPrefixes.get(owner) ?? '';
    routes.push({
      method: match[2].toUpperCase(),
      path: joinPath(prefix, match[3]),
      source,
      owner,
      file,
      confidence: prefix ? 0.88 : 0.84,
      evidence: [makeEvidence(file, `${source} route registration`, match.index ?? undefined)]
    });
  }
  return routes;
};

// ---------------------------------------------------------------------------
// chi
// ---------------------------------------------------------------------------

const CHI_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head'];

/**
 * chi uses capitalised method names (`r.Get("/x", h)`) and `r.Route("/p", func(r
 * chi.Router){...})` for nesting. We resolve Route prefixes with a textual
 * brace-depth stack: a Route opens a prefix scope that stays active until its
 * matching closing brace. This is a heuristic — it assumes routes are declared
 * inside the Route closure that textually contains them and does not model
 * router variables that escape their closure. Adequate for conventional chi code.
 */
const parseChiRoutes = (file: RepoFile): RouteSignal[] => {
  const routes: RouteSignal[] = [];
  const content = file.content;
  const methodAlt = CHI_METHODS.join('|');

  // Token scan: find Route opens, method calls, and brace transitions in order.
  interface Frame {
    prefix: string;
    closeDepth: number;
  }
  const stack: Frame[] = [];
  let depth = 0;

  const tokenRegex = new RegExp(
    `(\\w+)\\.Route\\(\\s*"([^"]*)"|(\\w+)\\.(${methodAlt})\\(\\s*"([^"]+)"|\\{|\\}`,
    'g'
  );

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(content)) !== null) {
    const token = match[0];
    if (token === '{') {
      depth += 1;
      continue;
    }
    if (token === '}') {
      depth -= 1;
      while (stack.length && stack[stack.length - 1].closeDepth > depth) {
        stack.pop();
      }
      continue;
    }
    if (match[1] !== undefined) {
      // Route open: prefix becomes active for the closure brace that follows.
      stack.push({ prefix: normalizePath(match[2]), closeDepth: depth });
      continue;
    }
    if (match[3] !== undefined) {
      const prefix = stack.map((frame) => frame.prefix).reduce((acc, p) => joinPath(acc, p), '');
      const fullPath = joinPath(prefix, match[5]);
      routes.push({
        method: match[4].toUpperCase(),
        path: fullPath,
        source: 'chi',
        owner: match[3],
        file,
        confidence: prefix && prefix !== '/' ? 0.86 : 0.82,
        evidence: [makeEvidence(file, 'chi route registration', match.index ?? undefined)]
      });
    }
  }
  return routes;
};

// ---------------------------------------------------------------------------
// gorilla/mux
// ---------------------------------------------------------------------------

const MUX_INTEGER_METHOD_CONST: Record<string, string> = {
  'http.MethodGet': 'GET',
  'http.MethodPost': 'POST',
  'http.MethodPut': 'PUT',
  'http.MethodPatch': 'PATCH',
  'http.MethodDelete': 'DELETE',
  'http.MethodOptions': 'OPTIONS',
  'http.MethodHead': 'HEAD'
};

/**
 * mux path params look like `{id}` or `{id:[0-9]+}`. Strip the regex constraint
 * and remember which params were numeric so we can type them as integer.
 */
const stripMuxPathRegex = (rawPath: string): { path: string; numericParams: Set<string> } => {
  const numericParams = new Set<string>();
  const cleaned = rawPath.replace(/\{(\w+)(?::([^}]*))?\}/g, (_full, name: string, pattern?: string) => {
    if (pattern && /\[0-9\]|\\d/.test(pattern)) {
      numericParams.add(name);
    }
    return `{${name}}`;
  });
  return { path: cleaned, numericParams };
};

const muxPathParams = (path: string, numericParams: Set<string>): SchemaField[] | undefined => {
  if (numericParams.size === 0) {
    return undefined;
  }
  const fields: SchemaField[] = [];
  for (const match of path.matchAll(/:(\w+)/g)) {
    const name = match[1];
    fields.push({ name, required: true, type: numericParams.has(name) ? 'integer' : 'string' });
  }
  return fields.length ? fields : undefined;
};

const parseMuxRoutes = (file: RepoFile): RouteSignal[] => {
  const routes: RouteSignal[] = [];
  // r.HandleFunc("/path", h).Methods("GET", "POST")  — capture the trailing .Methods(...) args.
  const regex = /(\w+)\.HandleFunc\(\s*"([^"]+)"\s*,[^)]*\)\s*\.Methods\(([^)]*)\)/g;
  for (const match of file.content.matchAll(regex)) {
    const owner = match[1];
    const { path: rawPath, numericParams } = stripMuxPathRegex(match[2]);
    const normalized = normalizePath(rawPath);
    const pathParams = muxPathParams(normalized, numericParams);

    const methodsArg = match[3];
    const methods: string[] = [];
    for (const m of methodsArg.matchAll(/"([A-Za-z]+)"|(\bhttp\.Method\w+)/g)) {
      if (m[1]) {
        methods.push(m[1].toUpperCase());
      } else if (m[2]) {
        const resolved = MUX_INTEGER_METHOD_CONST[m[2]];
        if (resolved) {
          methods.push(resolved);
        }
      }
    }
    if (methods.length === 0) {
      methods.push('GET');
    }
    for (const method of methods) {
      routes.push({
        method,
        path: normalized,
        source: 'mux',
        owner,
        file,
        confidence: 0.85,
        evidence: [makeEvidence(file, 'gorilla/mux route registration', match.index ?? undefined)],
        pathParams
      });
    }
  }
  return routes;
};

// ---------------------------------------------------------------------------
// net/http ServeMux (Go 1.22 pattern routing)
// ---------------------------------------------------------------------------

/**
 * Go 1.22 method-pattern routing: `mux.HandleFunc("GET /items/{id}", h)` or
 * `http.HandleFunc("POST /items", h)`. The pattern is an optional METHOD token,
 * a space, then the path. With no method token, net/http matches all methods;
 * we default to GET.
 */
const parseNetHttpRoutes = (file: RepoFile): RouteSignal[] => {
  const routes: RouteSignal[] = [];
  const regex = /(\w+)\.HandleFunc\(\s*"([^"]+)"\s*,/g;
  for (const match of file.content.matchAll(regex)) {
    const raw = match[2].trim();
    const patternMatch = raw.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S*)$/);
    let method: string;
    let path: string;
    if (patternMatch) {
      method = patternMatch[1].toUpperCase();
      path = patternMatch[2];
    } else if (/^\//.test(raw)) {
      // Plain path with no method token -> classic net/http, default GET.
      method = 'GET';
      path = raw;
    } else {
      continue;
    }
    routes.push({
      method,
      path: normalizePath(path),
      source: 'nethttp',
      owner: match[1],
      file,
      confidence: patternMatch ? 0.84 : 0.7,
      evidence: [makeEvidence(file, 'net/http pattern route', match.index ?? undefined)]
    });
  }
  return routes;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const dedupe = (routes: RouteSignal[]): RouteSignal[] => {
  const seen = new Set<string>();
  const out: RouteSignal[] = [];
  for (const route of routes) {
    const key = `${route.source}::${route.method}::${route.path}::${route.file.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(route);
  }
  return out;
};

export const parseGoRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!GO_FILE_REGEX.test(file.path)) {
      continue;
    }

    const router = detectRouter(file.content);
    switch (router) {
      case 'chi':
        routes.push(...parseChiRoutes(file));
        break;
      case 'echo':
        routes.push(...parseUppercaseMethodRoutes(file, 'echo'));
        break;
      case 'mux':
        routes.push(...parseMuxRoutes(file));
        break;
      case 'gin':
      default:
        routes.push(...parseUppercaseMethodRoutes(file, 'gin'));
        break;
    }

    // net/http pattern routing can coexist with any router (Go 1.22 ServeMux).
    // Only parse it when there are method-prefixed patterns to avoid mislabelling
    // the import-indicated router's plain HandleFunc calls.
    if (/\.HandleFunc\(\s*"(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//.test(file.content)) {
      routes.push(...parseNetHttpRoutes(file));
    }
  }

  return dedupe(routes);
};
