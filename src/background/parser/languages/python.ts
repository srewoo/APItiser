import type { RepoFile, SchemaField } from '@shared/types';
import { joinPath, makeBodySchema, makeEvidence, normalizePath } from '../endpointBuilder';
import type { RouteSignal } from '../routeTypes';

const PY_FILE_REGEX = /\.py$/i;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Python builtin scalar annotations and their JSON-schema type. */
const PY_TYPE_MAP: Record<string, string> = {
  int: 'integer',
  float: 'number',
  str: 'string',
  bool: 'boolean'
};

/** Params that are framework plumbing, not request inputs. */
const SKIP_PARAM_NAMES = new Set(['self', 'cls', 'request', 'req', 'db', 'session', 'background_tasks']);

const mapPyType = (annotation?: string): string => {
  if (!annotation) {
    return 'string';
  }
  const base = annotation.trim().replace(/^Optional\[/, '').replace(/\]$/, '').trim();
  return PY_TYPE_MAP[base] ?? 'string';
};

const isBuiltinType = (annotation?: string): boolean => {
  if (!annotation) {
    return false;
  }
  const base = annotation.trim().replace(/^Optional\[/, '').replace(/\]$/, '').trim();
  return base in PY_TYPE_MAP;
};

interface ParsedParam {
  name: string;
  annotation?: string;
  hasDefault: boolean;
  defaultExpr?: string;
}

/** Split a function arg list on top-level commas (ignores commas inside [], (), {}). */
const splitArgs = (argList: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of argList) {
    if (char === '[' || char === '(' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === ')' || char === '}') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
};

/** Parse a single function parameter declaration into name/annotation/default. */
const parseParam = (raw: string): ParsedParam | undefined => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('*')) {
    return undefined;
  }
  // Split name+annotation from default on the first top-level '='.
  let head = trimmed;
  let defaultExpr: string | undefined;
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex >= 0) {
    head = trimmed.slice(0, eqIndex).trim();
    defaultExpr = trimmed.slice(eqIndex + 1).trim();
  }
  const colonIndex = head.indexOf(':');
  const name = (colonIndex >= 0 ? head.slice(0, colonIndex) : head).trim();
  const annotation = colonIndex >= 0 ? head.slice(colonIndex + 1).trim() : undefined;
  if (!name) {
    return undefined;
  }
  return { name, annotation, hasDefault: defaultExpr !== undefined, defaultExpr };
};

/**
 * Find the handler signature that immediately follows a decorator at `afterIndex`.
 * Returns the parenthesised argument list as raw text, or undefined.
 */
const findHandlerArgs = (content: string, afterIndex: number): string | undefined => {
  const slice = content.slice(afterIndex);
  // Skip any further stacked decorators, then match the def signature.
  const defMatch = slice.match(/(?:^|\n)\s*(?:async\s+)?def\s+\w+\s*\(/);
  if (!defMatch || defMatch.index === undefined) {
    return undefined;
  }
  const openParenIndex = afterIndex + defMatch.index + defMatch[0].length - 1;
  // Walk to the matching close paren (signatures may span multiple lines).
  let depth = 0;
  for (let i = openParenIndex; i < content.length; i += 1) {
    const char = content[i];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openParenIndex + 1, i);
      }
    }
  }
  return undefined;
};

interface SignatureModel {
  pathParams: SchemaField[];
  queryParams: SchemaField[];
  body?: ReturnType<typeof makeBodySchema>;
}

/**
 * Map a handler signature to typed path params, query params, and (for write
 * methods) a Pydantic-model request body.
 */
const modelFromSignature = (
  argList: string | undefined,
  pathParamNames: Set<string>,
  method: string
): SignatureModel => {
  const pathParams: SchemaField[] = [];
  const queryParams: SchemaField[] = [];
  const bodyFields: Array<{ name: string; type: string; required: boolean }> = [];

  const typedPathParams = new Map<string, string>();

  if (argList) {
    for (const part of splitArgs(argList)) {
      const param = parseParam(part);
      if (!param || SKIP_PARAM_NAMES.has(param.name)) {
        continue;
      }
      // Skip dependency-injected params (e.g. db: Session = Depends(get_db)).
      if (param.defaultExpr && /Depends\s*\(/.test(param.defaultExpr)) {
        continue;
      }
      const required = !param.hasDefault;

      if (pathParamNames.has(param.name)) {
        typedPathParams.set(param.name, mapPyType(param.annotation));
        continue;
      }

      // Capitalised, non-builtin annotation => Pydantic model body (write methods).
      const isModel =
        !!param.annotation && !isBuiltinType(param.annotation) && /^[A-Z]/.test(param.annotation.trim());
      if (isModel && BODY_METHODS.has(method)) {
        bodyFields.push({ name: param.name, type: 'object', required: true });
        continue;
      }

      // Simple typed param not in the path => query param.
      if (isBuiltinType(param.annotation)) {
        queryParams.push({ name: param.name, required, type: mapPyType(param.annotation) });
      }
    }
  }

  // Emit path params in path-declaration order, typed where the signature told us.
  for (const name of pathParamNames) {
    pathParams.push({ name, required: true, type: typedPathParams.get(name) ?? 'string' });
  }

  const body = bodyFields.length ? makeBodySchema(bodyFields) : undefined;
  return { pathParams, queryParams, body };
};

/** Extract `{name}`-style path params from a raw (pre-normalised) path. */
const pathParamNamesFrom = (rawPath: string): Set<string> => {
  const names = new Set<string>();
  for (const m of rawPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    names.add(m[1]);
  }
  return names;
};

/**
 * Detect router/blueprint prefix bindings keyed by the variable they are
 * assigned to (FastAPI APIRouter(prefix=...) and Flask Blueprint(url_prefix=...)).
 */
const collectPrefixes = (content: string): Map<string, string> => {
  const prefixes = new Map<string, string>();

  // router = APIRouter(prefix="/v1")
  for (const m of content.matchAll(
    /(\w+)\s*=\s*APIRouter\s*\(([^)]*?)prefix\s*=\s*["']([^"']*)["']/gim
  )) {
    prefixes.set(m[1], m[3]);
  }

  // bp = Blueprint("name", __name__, url_prefix="/api")
  for (const m of content.matchAll(
    /(\w+)\s*=\s*Blueprint\s*\(([^)]*?)url_prefix\s*=\s*["']([^"']*)["']/gim
  )) {
    prefixes.set(m[1], m[3]);
  }

  return prefixes;
};

/** Convert a colon/curly path into the colon-style normalised path. */
const toColonPath = (rawPath: string): string =>
  normalizePath(rawPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'));

/** Apply an owner prefix (if any) to a raw path, returning a normalised path. */
const withPrefix = (prefixes: Map<string, string>, owner: string, rawPath: string): string => {
  const prefix = prefixes.get(owner);
  if (prefix) {
    return joinPath(prefix, rawPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'));
  }
  return toColonPath(rawPath);
};

const DJANGO_FILE_REGEX = /urls?\.py$/i;

const isDjangoFile = (file: RepoFile): boolean =>
  DJANGO_FILE_REGEX.test(file.path) ||
  /from\s+django\.urls\s+import|urlpatterns\s*=|from\s+rest_framework|@api_view\s*\(/.test(file.content);

/** Convert Django `<int:pk>` / `<slug>` converters to `:name` and capture int params. */
const convertDjangoPath = (rawPath: string): { path: string; intParams: Set<string> } => {
  const intParams = new Set<string>();
  const converted = rawPath.replace(/<(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)>/g, (_full, conv, name) => {
    if (conv === 'int') {
      intParams.add(name);
    }
    return `:${name}`;
  });
  return { path: normalizePath(converted), intParams };
};

const djangoPathParams = (path: string, intParams: Set<string>): SchemaField[] => {
  const fields: SchemaField[] = [];
  for (const m of path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    fields.push({ name: m[1], required: true, type: intParams.has(m[1]) ? 'integer' : 'string' });
  }
  return fields;
};

/** Parse Django urls.py path()/re_path()/url() entries and DRF @api_view decorators. */
const parseDjangoRoutes = (file: RepoFile): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  // path("api/items/", views.x) / re_path(r"^...$", ...) / url(r"...", ...)
  for (const m of file.content.matchAll(
    /\b(?:re_path|path|url)\s*\(\s*[rR]?["']([^"']*)["']/gim
  )) {
    const raw = m[1];
    // Strip regex anchors for re_path/url patterns.
    const cleaned = raw.replace(/^\^/, '').replace(/\$$/, '');
    const { path, intParams } = convertDjangoPath(cleaned);
    routes.push({
      method: 'GET',
      path,
      source: 'django',
      owner: 'urlpatterns',
      file,
      confidence: 0.9,
      pathParams: djangoPathParams(path, intParams),
      evidence: [makeEvidence(file, 'django urls.py path entry', m.index ?? undefined)]
    });
  }

  // DRF: @api_view(["GET", "POST"]) above a def -> methods from the decorator.
  for (const m of file.content.matchAll(/@api_view\s*\(\s*\[([^\]]*)\]\s*\)/gim)) {
    const methodTokens = m[1].match(/["']([A-Za-z]+)["']/g) ?? [];
    const methods = methodTokens
      .map((token) => token.replace(/["']/g, '').toUpperCase())
      .filter((method) => HTTP_METHODS.has(method));
    for (const method of methods) {
      routes.push({
        method,
        path: '/',
        source: 'django',
        owner: 'api_view',
        file,
        confidence: 0.7,
        evidence: [makeEvidence(file, 'DRF @api_view decorator', m.index ?? undefined)]
      });
    }
  }

  return routes;
};

export const parsePythonRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!PY_FILE_REGEX.test(file.path)) {
      continue;
    }

    if (isDjangoFile(file)) {
      routes.push(...parseDjangoRoutes(file));
      // urls.py files don't carry FastAPI/Flask decorators; skip the rest.
      if (DJANGO_FILE_REGEX.test(file.path)) {
        continue;
      }
    }

    const isFastApi = /from\s+fastapi\s+import|FastAPI\s*\(|APIRouter\s*\(/i.test(file.content);
    const source = isFastApi ? 'fastapi' : ('flask' as const);
    const prefixes = collectPrefixes(file.content);

    // FastAPI/Flask method decorators. Tolerant of multi-line decorator bodies.
    for (const match of file.content.matchAll(
      /@(\w+)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']+)["']/gim
    )) {
      const owner = match[1];
      const method = match[2].toUpperCase();
      const rawPath = match[3];
      const path = withPrefix(prefixes, owner, rawPath);
      const decoratorEnd = (match.index ?? 0) + match[0].length;
      const args = findHandlerArgs(file.content, decoratorEnd);
      const { pathParams, queryParams, body } = modelFromSignature(
        args,
        pathParamNamesFrom(rawPath),
        method
      );
      routes.push({
        method,
        path,
        source,
        owner,
        file,
        confidence: 0.92,
        evidence: [makeEvidence(file, `${source} decorator route`, match.index ?? undefined)],
        ...(pathParams.length ? { pathParams } : {}),
        ...(queryParams.length ? { queryParams } : {}),
        ...(body ? { body } : {})
      });
    }

    // Flask @route with explicit methods list. Tolerant of multi-line args.
    for (const match of file.content.matchAll(
      /@(\w+)\.route\(\s*["']([^"']+)["'][\s\S]*?methods\s*=\s*\[([^\]]+)\]/gim
    )) {
      const owner = match[1];
      const rawPath = match[2];
      const path = withPrefix(prefixes, owner, rawPath);
      const methodTokens = match[3].match(/["']([A-Za-z]+)["']/gim) ?? [];
      const methods = methodTokens
        .map((token) => token.replace(/["']/g, '').toUpperCase())
        .filter((method) => HTTP_METHODS.has(method));
      const decoratorEnd = (match.index ?? 0) + match[0].length;
      const args = findHandlerArgs(file.content, decoratorEnd);
      const pathNames = pathParamNamesFrom(rawPath);
      for (const method of methods) {
        const { pathParams, queryParams, body } = modelFromSignature(args, pathNames, method);
        routes.push({
          method,
          path,
          source: 'flask',
          owner,
          file,
          confidence: 0.9,
          evidence: [makeEvidence(file, 'flask @route methods declaration', match.index ?? undefined)],
          ...(pathParams.length ? { pathParams } : {}),
          ...(queryParams.length ? { queryParams } : {}),
          ...(body ? { body } : {})
        });
      }
    }
  }

  return routes;
};
