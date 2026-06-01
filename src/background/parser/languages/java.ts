import type { RepoFile, SchemaField, SchemaObject } from '@shared/types';
import { joinPath, makeBodySchema, makeEvidence, normalizePath } from '../endpointBuilder';
import type { RouteSignal } from '../routeTypes';

const JAVA_FILE_REGEX = /\.java$/i;

/** Map a Java type token to a JSON-schema primitive type. */
const javaTypeToSchema = (raw: string): string => {
  const type = raw.trim().replace(/<.*>$/, '');
  switch (type) {
    case 'int':
    case 'Integer':
    case 'long':
    case 'Long':
    case 'short':
    case 'Short':
    case 'BigInteger':
      return 'integer';
    case 'double':
    case 'Double':
    case 'float':
    case 'Float':
    case 'BigDecimal':
      return 'number';
    case 'boolean':
    case 'Boolean':
      return 'boolean';
    default:
      return 'string';
  }
};

interface ParsedParam {
  rawType: string;
  varName: string;
}

/**
 * Split a method parameter list into individual `[annotations] Type name` units,
 * respecting nesting in generics (`Map<String, Object>`) and annotation argument
 * parentheses (`@RequestParam(required = false)`).
 */
const splitParams = (paramList: string): string[] => {
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of paramList) {
    if (char === '<' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '>' || char === ')' || char === ']') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      params.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    params.push(current);
  }
  return params;
};

/** Extract `Type varName` from a parameter chunk after its leading annotations. */
const parseTypeAndName = (chunk: string): ParsedParam | undefined => {
  // Strip leading annotations (with optional argument lists).
  const withoutAnnotations = chunk.replace(/@[A-Za-z0-9_]+(\([^)]*\))?/g, ' ').trim();
  const tokens = withoutAnnotations.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return undefined;
  }
  const varName = tokens[tokens.length - 1].replace(/[^A-Za-z0-9_]/g, '');
  const rawType = tokens[tokens.length - 2];
  if (!varName || !rawType) {
    return undefined;
  }
  return { rawType, varName };
};

/** Read the explicit name argument from an annotation like @RequestParam("id") or @PathParam("id"). */
const explicitAnnotationName = (chunk: string, annotation: string): string | undefined => {
  const regex = new RegExp(`@${annotation}\\s*\\(([^)]*)\\)`);
  const match = chunk.match(regex);
  if (!match) {
    return undefined;
  }
  const args = match[1];
  // Prefer value = "..." / name = "..." then a bare "..." form.
  const named = args.match(/(?:value|name)\s*=\s*"([^"]+)"/);
  if (named) {
    return named[1];
  }
  const bare = args.match(/^\s*"([^"]+)"/);
  return bare?.[1];
};

const annotationHas = (chunk: string, annotation: string): boolean =>
  new RegExp(`@${annotation}\\b`).test(chunk);

interface MethodEnrichment {
  pathParams: SchemaField[];
  queryParams: SchemaField[];
  body?: SchemaObject;
}

/**
 * Extract the method parameter list immediately following the annotation block at `fromIndex`.
 * Returns the raw text inside the first `(...)` of the next method declaration.
 */
const extractParamList = (content: string, fromIndex: number): string | undefined => {
  const rest = content.slice(fromIndex);
  // Find the first '(' that opens a parameter list. We skip any annotation argument
  // parentheses that may sit between the mapping annotation and the method declaration.
  // A method declaration looks like `... methodName(`.
  const methodDecl = rest.match(/\b[A-Za-z0-9_<>,.[\]\s]+\s+[A-Za-z0-9_]+\s*\(/);
  if (!methodDecl || methodDecl.index === undefined) {
    return undefined;
  }
  const openIndex = fromIndex + methodDecl.index + methodDecl[0].length - 1;
  let depth = 0;
  for (let i = openIndex; i < content.length; i += 1) {
    const char = content[i];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openIndex + 1, i);
      }
    }
  }
  return undefined;
};

/** Extract private field declarations from an in-file DTO class as body schema fields. */
const extractDtoBody = (content: string, dtoType: string): SchemaObject => {
  const cleanType = dtoType.replace(/<.*>$/, '').trim();
  // Match `class CleanType { ... }` and capture the body up to the matching brace.
  const classRegex = new RegExp(`\\b(?:class|record)\\s+${cleanType}\\b[^{]*\\{`);
  const classMatch = content.match(classRegex);
  if (!classMatch || classMatch.index === undefined) {
    return { type: 'object' };
  }
  const openIndex = content.indexOf('{', classMatch.index);
  let depth = 0;
  let endIndex = -1;
  for (let i = openIndex; i < content.length; i += 1) {
    if (content[i] === '{') {
      depth += 1;
    } else if (content[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }
  if (endIndex === -1) {
    return { type: 'object' };
  }
  const body = content.slice(openIndex + 1, endIndex);
  const fields: Array<{ name: string; type: string; required: boolean }> = [];
  for (const fieldMatch of body.matchAll(
    /private\s+(?:final\s+)?([A-Za-z0-9_<>,.[\]]+)\s+([A-Za-z0-9_]+)\s*[;=]/g
  )) {
    fields.push({
      name: fieldMatch[2],
      type: javaTypeToSchema(fieldMatch[1]),
      required: false
    });
  }
  return makeBodySchema(fields) ?? { type: 'object' };
};

/**
 * Inspect a handler method's parameter list and recover path params (with typing),
 * query params, and a request body schema.
 */
const enrichFromParams = (
  content: string,
  paramList: string,
  knownPathParams: Set<string>
): MethodEnrichment => {
  const pathParams: SchemaField[] = [];
  const queryParams: SchemaField[] = [];
  let body: SchemaObject | undefined;

  for (const chunk of splitParams(paramList)) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }

    if (annotationHas(trimmed, 'PathVariable') || annotationHas(trimmed, 'PathParam')) {
      const parsed = parseTypeAndName(trimmed);
      if (!parsed) {
        continue;
      }
      const annotation = annotationHas(trimmed, 'PathVariable') ? 'PathVariable' : 'PathParam';
      const name = explicitAnnotationName(trimmed, annotation) ?? parsed.varName;
      pathParams.push({
        name,
        required: true,
        type: javaTypeToSchema(parsed.rawType)
      });
      continue;
    }

    if (annotationHas(trimmed, 'RequestParam') || annotationHas(trimmed, 'QueryParam')) {
      const parsed = parseTypeAndName(trimmed);
      if (!parsed) {
        continue;
      }
      const annotation = annotationHas(trimmed, 'RequestParam') ? 'RequestParam' : 'QueryParam';
      const name = explicitAnnotationName(trimmed, annotation) ?? parsed.varName;
      const optional =
        /required\s*=\s*false/.test(trimmed) || /defaultValue\s*=/.test(trimmed);
      // JAX-RS @QueryParam has no required notion; default to optional unless @NotNull is present.
      const required =
        annotation === 'RequestParam' ? !optional : annotationHas(trimmed, 'NotNull');
      queryParams.push({
        name,
        required,
        type: javaTypeToSchema(parsed.rawType)
      });
      continue;
    }

    if (annotationHas(trimmed, 'RequestBody')) {
      const parsed = parseTypeAndName(trimmed);
      if (parsed) {
        body = extractDtoBody(content, parsed.rawType);
      } else {
        body = { type: 'object' };
      }
    }
  }

  // Ensure any path param present in the route string but not annotated still appears (typed as string).
  for (const name of knownPathParams) {
    if (!pathParams.some((param) => param.name === name)) {
      pathParams.push({ name, required: true, type: 'string' });
    }
  }

  return { pathParams, queryParams, body };
};

const pathParamNames = (methodPath: string): Set<string> => {
  const names = new Set<string>();
  for (const match of methodPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    names.add(match[1]);
  }
  return names;
};

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

/** Detect Spring MVC mappings (@GetMapping etc. and @RequestMapping with explicit method). */
const parseSpring = (file: RepoFile): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  // Only treat @RequestMapping as a class-level prefix when it lacks a `method = RequestMethod.X` qualifier,
  // which indicates a method-level handler annotation rather than a controller prefix.
  const classPrefixMatch = file.content.match(
    /@RequestMapping\((?:value|path)?\s*=?\s*\{?\s*"([^"]+)"(?![^)]*RequestMethod\.)/
  );
  const classPrefix = classPrefixMatch ? normalizePath(classPrefixMatch[1]) : '';

  for (const match of file.content.matchAll(
    /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\(([\s\S]*?)\)/g
  )) {
    const annotation = match[1];
    const annotationBody = match[2];
    const pathMatch = annotationBody.match(/(?:value|path)?\s*=?\s*\{?\s*"([^"]+)"/);
    const methodMatch = annotationBody.match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)/);

    if (annotation === 'RequestMapping' && !methodMatch) {
      continue;
    }

    const method = resolveSpringMethod(annotation, methodMatch);
    const methodPath = pathMatch?.[1] ?? '';

    const annotationEnd = (match.index ?? 0) + match[0].length;
    const paramList = extractParamList(file.content, annotationEnd);
    const enrichment = paramList
      ? enrichFromParams(file.content, paramList, pathParamNames(methodPath))
      : { pathParams: [], queryParams: [], body: undefined };

    routes.push({
      method: method.toUpperCase(),
      path: joinPath(classPrefix, methodPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')),
      source: 'spring',
      owner: 'controller',
      file,
      confidence: classPrefix ? 0.9 : 0.86,
      evidence: [makeEvidence(file, 'spring controller mapping', match.index ?? undefined)],
      pathParams: enrichment.pathParams.length ? enrichment.pathParams : undefined,
      queryParams: enrichment.queryParams.length ? enrichment.queryParams : undefined,
      body: enrichment.body
    });
  }

  return routes;
};

const JAXRS_HTTP_ANNOTATIONS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] as const;

/** Read a class-level @Path prefix (the first @Path that sits before any HTTP-method annotation). */
const jaxRsClassPrefix = (content: string): string => {
  const httpAnnotation = content.search(/@(?:GET|POST|PUT|DELETE|PATCH|HEAD)\b/);
  const searchScope = httpAnnotation === -1 ? content : content.slice(0, httpAnnotation);
  const match = searchScope.match(/@Path\s*\(\s*"([^"]+)"\s*\)/);
  return match ? normalizePath(match[1]) : '';
};

/**
 * Detect JAX-RS resources: class-level @Path prefix plus method-level HTTP annotations
 * (@GET/@POST/...) and optional method-level @Path.
 */
const parseJaxRs = (file: RepoFile): RouteSignal[] => {
  const { content } = file;
  // Require at least one JAX-RS HTTP-method annotation to treat the file as JAX-RS.
  if (!/@(?:GET|POST|PUT|DELETE|PATCH|HEAD)\b/.test(content)) {
    return [];
  }

  const classPrefix = jaxRsClassPrefix(content);
  const routes: RouteSignal[] = [];

  const annotationGroup = JAXRS_HTTP_ANNOTATIONS.join('|');
  const httpRegex = new RegExp(`@(${annotationGroup})\\b`, 'g');

  for (const match of content.matchAll(httpRegex)) {
    const method = match[1];
    const start = match.index ?? 0;

    // Look at the block between this HTTP annotation and the method declaration body to find
    // an adjacent method-level @Path and the parameter list. We bound the block at the method
    // declaration's parameter list rather than the first `{`, since a path template such as
    // @Path("/items/{id}") legitimately contains a brace.
    const declMatch = content
      .slice(start)
      .match(/\b[A-Za-z0-9_<>,.[\]\s]+\s+[A-Za-z0-9_]+\s*\(/);
    const blockEnd =
      declMatch && declMatch.index !== undefined ? start + declMatch.index : content.length;
    const block = content.slice(start, blockEnd);

    const methodPathMatch = block.match(/@Path\s*\(\s*"([^"]+)"\s*\)/);
    const methodPath = methodPathMatch?.[1] ?? '';

    const paramList = extractParamList(content, start);
    const enrichment = paramList
      ? enrichFromParams(content, paramList, pathParamNames(methodPath))
      : { pathParams: [], queryParams: [], body: undefined };

    routes.push({
      method: method.toUpperCase(),
      path: joinPath(classPrefix, methodPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')),
      source: 'jaxrs',
      owner: 'resource',
      file,
      confidence: classPrefix ? 0.9 : 0.85,
      evidence: [makeEvidence(file, 'jax-rs resource method', start)],
      pathParams: enrichment.pathParams.length ? enrichment.pathParams : undefined,
      queryParams: enrichment.queryParams.length ? enrichment.queryParams : undefined,
      body: enrichment.body
    });
  }

  return routes;
};

export const parseSpringRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!JAVA_FILE_REGEX.test(file.path)) {
      continue;
    }
    routes.push(...parseSpring(file));
    routes.push(...parseJaxRs(file));
  }

  return routes;
};
