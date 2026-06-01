import { parse } from '@babel/parser';
import type { Expression, File, ObjectExpression } from '@babel/types';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { ApiEndpoint, RepoFile } from '@shared/types';
import {
  buildEndpoint,
  clampConfidence,
  exampleFromSchema,
  joinPath,
  makeBodySchema,
  makeEvidence,
  normalizePath,
  sampleForType
} from './endpointBuilder';
import type { SchemaField, SchemaObject } from '@shared/types';
import { parsePythonRoutes } from './languages/python';
import { parseGoRoutes } from './languages/go';
import { parseSpringRoutes } from './languages/java';
import type { FileAnalysis, ImportBinding, MountSignal, RouteSignal } from './routeTypes';

const JS_FILE_REGEX = /\.(?:[cm]?[jt]sx?)$/i;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const EXPRESS_IMPORTS = new Set(['express']);
const FASTIFY_IMPORTS = new Set(['fastify']);
const KOA_IMPORTS = new Set(['koa-router', '@koa/router']);
const HONO_IMPORTS = new Set(['hono']);

const normalizeFsPath = (input: string): string => {
  const parts = input.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
};

const dirname = (filePath: string): string => {
  const index = filePath.lastIndexOf('/');
  if (index < 0) {
    return '';
  }
  return filePath.slice(0, index);
};

const resolveImport = (fromPath: string, source: string, files: Set<string>): string | undefined => {
  if (!source.startsWith('.')) {
    return undefined;
  }

  const base = dirname(fromPath);
  const merged = normalizeFsPath(`${base}/${source}`);
  const candidates = [
    merged,
    `${merged}.ts`,
    `${merged}.tsx`,
    `${merged}.js`,
    `${merged}.jsx`,
    `${merged}.mjs`,
    `${merged}.cjs`,
    `${merged}/index.ts`,
    `${merged}/index.tsx`,
    `${merged}/index.js`,
    `${merged}/index.jsx`,
    `${merged}/index.mjs`,
    `${merged}/index.cjs`
  ];

  return candidates.find((candidate) => files.has(candidate));
};

const parseAst = (file: RepoFile): File | null => {
  try {
    return parse(file.content, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['typescript', 'jsx', 'decorators-legacy']
    });
  } catch {
    return null;
  }
};

const methodFromDecorator = (name: string): string | null => {
  const normalized = name.toUpperCase();
  if (HTTP_METHODS.has(normalized)) {
    return normalized;
  }
  return null;
};

const toStringValue = (expression: unknown, values: Map<string, string>): string | undefined => {
  const node = expression as t.Node | null | undefined;
  if (!node || !t.isExpression(node)) {
    return undefined;
  }

  if (t.isStringLiteral(node)) {
    return node.value;
  }
  if (t.isNumericLiteral(node)) {
    return `${node.value}`;
  }
  if (t.isTemplateLiteral(node)) {
    let value = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      value += node.quasis[index].value.cooked ?? '';
      const expr = node.expressions[index];
      if (expr && t.isExpression(expr)) {
        const resolved = toStringValue(expr, values);
        if (resolved === undefined) {
          return undefined;
        }
        value += resolved;
      }
    }
    return value;
  }
  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = toStringValue(node.left, values);
    const right = toStringValue(node.right, values);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    return `${left}${right}`;
  }
  if (t.isIdentifier(node)) {
    return values.get(node.name);
  }
  if (t.isParenthesizedExpression(node)) {
    return toStringValue(node.expression, values);
  }
  if (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node) || t.isTSTypeAssertion(node)) {
    return toStringValue(node.expression, values);
  }
  if (t.isConditionalExpression(node)) {
    const consequent = toStringValue(node.consequent, values);
    const alternate = toStringValue(node.alternate, values);
    if (consequent && alternate && consequent === alternate) {
      return consequent;
    }
  }

  return undefined;
};

const getPropName = (input: t.Identifier | t.StringLiteral | t.NumericLiteral | t.Expression | t.PrivateName): string | null => {
  if (t.isIdentifier(input)) {
    return input.name;
  }
  if (t.isStringLiteral(input)) {
    return input.value;
  }
  if (t.isNumericLiteral(input)) {
    return `${input.value}`;
  }
  return null;
};

const resolveMethodList = (expression: t.Expression, values: Map<string, string>): string[] => {
  if (t.isStringLiteral(expression)) {
    return [expression.value.toUpperCase()];
  }
  if (t.isArrayExpression(expression)) {
    const methods: string[] = [];
    for (const element of expression.elements) {
      if (!element || !t.isExpression(element)) {
        continue;
      }
      const resolved = toStringValue(element, values);
      if (resolved && HTTP_METHODS.has(resolved.toUpperCase())) {
        methods.push(resolved.toUpperCase());
      }
    }
    return methods;
  }
  const resolved = toStringValue(expression, values);
  if (resolved && HTTP_METHODS.has(resolved.toUpperCase())) {
    return [resolved.toUpperCase()];
  }
  return [];
};

const parseNextPathFromFile = (filePath: string): string | undefined => {
  const normalized = filePath.replace(/^\/+/, '');
  const appMatch = normalized.match(/^app\/(.+)\/route\.(?:[cm]?[jt]sx?)$/i);
  if (appMatch) {
    const segments = appMatch[1]
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        const optionalCatchAll = segment.match(/^\[\[\.\.\.([A-Za-z0-9_]+)\]\]$/);
        if (optionalCatchAll) {
          return `:${optionalCatchAll[1]}*`;
        }
        const catchAll = segment.match(/^\[\.\.\.([A-Za-z0-9_]+)\]$/);
        if (catchAll) {
          return `:${catchAll[1]}*`;
        }
        const dynamic = segment.match(/^\[([A-Za-z0-9_]+)\]$/);
        if (dynamic) {
          return `:${dynamic[1]}`;
        }
        return segment;
      });
    return normalizePath(segments.join('/'));
  }

  const pagesMatch = normalized.match(/^pages\/api\/(.+)\.(?:[cm]?[jt]sx?)$/i);
  if (pagesMatch) {
    const withoutIndex = pagesMatch[1].replace(/\/index$/i, '');
    const segments = withoutIndex
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        const catchAll = segment.match(/^\[\.\.\.([A-Za-z0-9_]+)\]$/);
        if (catchAll) {
          return `:${catchAll[1]}*`;
        }
        const dynamic = segment.match(/^\[([A-Za-z0-9_]+)\]$/);
        if (dynamic) {
          return `:${dynamic[1]}`;
        }
        return segment;
      });
    return normalizePath(`api/${segments.join('/')}`);
  }

  return undefined;
};

const inferSourceForOwner = (
  owner: string,
  ownerKinds: Map<string, ApiEndpoint['source']>,
  imports: Map<string, ImportBinding>
): ApiEndpoint['source'] | undefined => {
  const mapped = ownerKinds.get(owner);
  if (mapped) {
    return mapped;
  }

  if (owner === 'router' || owner === 'app') {
    for (const binding of imports.values()) {
      if (EXPRESS_IMPORTS.has(binding.source)) {
        return 'express';
      }
      if (KOA_IMPORTS.has(binding.source)) {
        return 'koa';
      }
      if (FASTIFY_IMPORTS.has(binding.source)) {
        return 'fastify';
      }
      if (HONO_IMPORTS.has(binding.source)) {
        return 'hono';
      }
    }
  }

  if (owner === 'fastify' || owner === 'server') {
    return 'fastify';
  }

  if (owner === 'router' || owner === 'app') {
    return 'express';
  }

  return undefined;
};

const collectObjectProperties = (objectExpression: ObjectExpression) => {
  const props = new Map<string, t.Expression>();

  for (const property of objectExpression.properties) {
    if (t.isObjectProperty(property)) {
      const key = getPropName(property.key);
      if (key && t.isExpression(property.value)) {
        props.set(key, property.value);
      }
    } else if (t.isObjectMethod(property)) {
      const key = getPropName(property.key);
      if (key) {
        props.set(key, t.stringLiteral('[function]'));
      }
    }
  }

  return props;
};

const routeFromObjectPattern = (
  expression: t.CallExpression,
  file: RepoFile,
  values: Map<string, string>,
  ownerKinds: Map<string, ApiEndpoint['source']>,
  imports: Map<string, ImportBinding>,
  routes: RouteSignal[]
) => {
  if (!t.isMemberExpression(expression.callee)) {
    return;
  }
  const objectName = t.isIdentifier(expression.callee.object) ? expression.callee.object.name : undefined;
  const methodName = getPropName(expression.callee.property);
  if (!objectName || methodName !== 'route') {
    return;
  }

  const source = inferSourceForOwner(objectName, ownerKinds, imports);
  const fastifyLikeOwner = objectName === 'fastify' || objectName === 'server' || objectName === 'app';
  if (source && source !== 'fastify' && !fastifyLikeOwner) {
    return;
  }

  const [firstArg] = expression.arguments;
  if (!firstArg || !t.isObjectExpression(firstArg)) {
    return;
  }
  const props = collectObjectProperties(firstArg);
  const methodExpr = props.get('method');
  const pathExpr = props.get('url') ?? props.get('path');
  if (!methodExpr || !pathExpr) {
    return;
  }
  const methods = resolveMethodList(methodExpr, values);
  const path = toStringValue(pathExpr, values);
  if (!path) {
    return;
  }

  // fastify.route({ schema: { body, querystring }, handler }) — recover signals
  // from both the schema option object and any inline handler function.
  const { body, queryParams } = extractRouteCallSignals([firstArg], values);

  for (const method of methods) {
    if (!HTTP_METHODS.has(method)) {
      continue;
    }
    routes.push({
      method,
      path: normalizePath(path),
      owner: objectName,
      source: 'fastify',
      file,
      confidence: 0.95,
      evidence: [makeEvidence(file, 'fastify.route() declaration', expression.start ?? undefined)],
      body,
      queryParams
    });
  }
};

const routeFromChainedRouteCall = (
  expression: t.CallExpression,
  file: RepoFile,
  values: Map<string, string>,
  ownerKinds: Map<string, ApiEndpoint['source']>,
  imports: Map<string, ImportBinding>,
  routes: RouteSignal[]
) => {
  if (!t.isMemberExpression(expression.callee)) {
    return;
  }

  const chainedMethod = getPropName(expression.callee.property)?.toUpperCase();
  if (!chainedMethod || !HTTP_METHODS.has(chainedMethod) || !t.isCallExpression(expression.callee.object)) {
    return;
  }

  let routeBuilderCall: t.CallExpression = expression.callee.object;
  while (t.isMemberExpression(routeBuilderCall.callee) && t.isCallExpression(routeBuilderCall.callee.object)) {
    routeBuilderCall = routeBuilderCall.callee.object;
  }

  if (!t.isMemberExpression(routeBuilderCall.callee)) {
    return;
  }

  const routeBuilderMethod = getPropName(routeBuilderCall.callee.property);
  const ownerName = t.isIdentifier(routeBuilderCall.callee.object) ? routeBuilderCall.callee.object.name : undefined;
  if (!ownerName || routeBuilderMethod !== 'route') {
    return;
  }

  const source = inferSourceForOwner(ownerName, ownerKinds, imports);
  if (source !== 'express') {
    return;
  }

  const routePath = toStringValue(routeBuilderCall.arguments[0] as Expression | undefined, values);
  if (!routePath) {
    return;
  }

  const { body, queryParams } = extractRouteCallSignals(expression.arguments, values);

  routes.push({
    method: chainedMethod,
    path: normalizePath(routePath),
    owner: ownerName,
    source,
    file,
    confidence: 0.93,
    evidence: [makeEvidence(file, `express chained route ${chainedMethod}`, expression.start ?? undefined)],
    body,
    queryParams
  });
};

interface HandlerSignals {
  bodyFields: Map<string, { type?: string; format?: string; required?: boolean }>;
  queryNames: Set<string>;
}

const newHandlerSignals = (): HandlerSignals => ({
  bodyFields: new Map(),
  queryNames: new Set()
});

const hasSignals = (signals: HandlerSignals): boolean =>
  signals.bodyFields.size > 0 || signals.queryNames.size > 0;

/** Returns the chain of property names for a member expression like a.b.c -> ['a','b','c']. */
const memberChain = (node: t.Node): string[] | null => {
  if (t.isIdentifier(node)) {
    return [node.name];
  }
  if (t.isMemberExpression(node) && !node.computed) {
    const base = memberChain(node.object);
    const prop = getPropName(node.property);
    if (base && prop) {
      return [...base, prop];
    }
  }
  return null;
};

/**
 * Detects whether a member chain (string segments) ends in `.body` / `.query`
 * for the common Express/Koa accessors. Returns the kind and the trailing
 * field name if the chain references a specific property.
 */
const classifyAccessor = (
  chain: string[]
): { kind: 'body' | 'query'; field?: string } | null => {
  // Find the last occurrence of 'body' or 'query' that follows req/request/ctx-like roots.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const segment = chain[i];
    if (segment !== 'body' && segment !== 'query') {
      continue;
    }
    const prev = chain[i - 1];
    // req.body / request.body / ctx.request.body (prev === request) / state etc.
    if (prev === 'req' || prev === 'request') {
      const field = chain[i + 1];
      return { kind: segment as 'body' | 'query', field };
    }
  }
  return null;
};

/** Collect names destructured out of an ObjectPattern (const { a, b } = ...). */
const namesFromObjectPattern = (pattern: t.ObjectPattern): string[] => {
  const names: string[] = [];
  for (const prop of pattern.properties) {
    if (t.isObjectProperty(prop)) {
      const name = getPropName(prop.key);
      if (name) {
        names.push(name);
      }
    } else if (t.isRestElement(prop) && t.isIdentifier(prop.argument)) {
      names.push(prop.argument.name);
    }
  }
  return names;
};

/**
 * Walk a handler function body and recover body/query signals from:
 *  - destructuring: const { a, b } = req.body / req.query / ctx.request.body
 *  - member access: req.body.field / req.query.field
 *  - Hono: c.req.query('x'), const { a } = await c.req.json()
 */
const extractHandlerSignals = (handler: t.Node, signals: HandlerSignals): void => {
  try {
    const body = (handler as { body?: t.Node }).body;
    if (!body) {
      return;
    }

    const visit = (node: t.Node | null | undefined): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      // const { a, b } = <something that resolves to body/query/json>
      if (t.isVariableDeclarator(node) && t.isObjectPattern(node.id) && node.init) {
        const init = node.init;
        const inner = t.isAwaitExpression(init) ? init.argument : init;

        // Hono: await c.req.json()
        if (
          t.isCallExpression(inner) &&
          t.isMemberExpression(inner.callee) &&
          getPropName(inner.callee.property) === 'json'
        ) {
          const calleeChain = memberChain(inner.callee.object);
          if (calleeChain && calleeChain.includes('req')) {
            for (const name of namesFromObjectPattern(node.id)) {
              if (!signals.bodyFields.has(name)) {
                signals.bodyFields.set(name, { required: true });
              }
            }
          }
        }

        // const { a } = req.body / req.query / ctx.request.body
        const chain = memberChain(inner);
        if (chain) {
          const classified = classifyAccessor(chain);
          if (classified && classified.field === undefined) {
            for (const name of namesFromObjectPattern(node.id)) {
              if (classified.kind === 'body') {
                if (!signals.bodyFields.has(name)) {
                  signals.bodyFields.set(name, { required: true });
                }
              } else {
                signals.queryNames.add(name);
              }
            }
          }
        }
      }

      // member access: req.body.field / req.query.field
      if (t.isMemberExpression(node) && !node.computed) {
        const chain = memberChain(node);
        if (chain) {
          const classified = classifyAccessor(chain);
          if (classified && classified.field) {
            if (classified.kind === 'body') {
              if (!signals.bodyFields.has(classified.field)) {
                signals.bodyFields.set(classified.field, { required: true });
              }
            } else {
              signals.queryNames.add(classified.field);
            }
          }
        }
      }

      // Hono: c.req.query('x')
      if (
        t.isCallExpression(node) &&
        t.isMemberExpression(node.callee) &&
        getPropName(node.callee.property) === 'query'
      ) {
        const calleeChain = memberChain(node.callee.object);
        if (calleeChain && calleeChain.includes('req')) {
          const arg = node.arguments[0];
          if (arg && t.isStringLiteral(arg)) {
            signals.queryNames.add(arg.value);
          }
        }
      }

      // Recurse into children.
      for (const key of Object.keys(node) as Array<keyof typeof node>) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') {
          continue;
        }
        const value = (node as unknown as Record<string, unknown>)[key as string];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object' && 'type' in item) {
              visit(item as t.Node);
            }
          }
        } else if (value && typeof value === 'object' && 'type' in (value as object)) {
          visit(value as t.Node);
        }
      }
    };

    visit(body);
  } catch {
    // Defensive: AST shapes vary; never throw out of the analyzer.
  }
};

/** Convert collected handler signals into RouteSignal body/queryParams fields. */
const signalsToRouteFields = (
  signals: HandlerSignals
): { body?: SchemaObject; queryParams?: SchemaField[] } => {
  const result: { body?: SchemaObject; queryParams?: SchemaField[] } = {};

  if (signals.bodyFields.size > 0) {
    const fields = [...signals.bodyFields.entries()].map(([name, meta]) => ({
      name,
      type: meta.type ?? 'string',
      required: meta.required ?? true,
      format: meta.format
    }));
    const body = makeBodySchema(fields);
    if (body) {
      result.body = body;
    }
  }

  if (signals.queryNames.size > 0) {
    result.queryParams = [...signals.queryNames].map((name) => ({
      name,
      required: false,
      type: 'string'
    }));
  }

  return result;
};

/** Find the handler function node among a route call's arguments (skips the path arg). */
const findHandlerNode = (args: ReadonlyArray<t.Node>): t.Node | undefined => {
  for (const arg of args) {
    if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
      return arg;
    }
  }
  return undefined;
};

/** Map a JSON-schema-ish type expression to our primitive type string. */
const jsonSchemaType = (expr: t.Expression | undefined, values: Map<string, string>): string | undefined => {
  const raw = expr ? toStringValue(expr, values) : undefined;
  if (!raw) {
    return undefined;
  }
  const normalized = raw.toLowerCase();
  if (['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(normalized)) {
    return normalized === 'integer' ? 'integer' : normalized;
  }
  return undefined;
};

/** Read `properties: { name: { type: 'string' }, ... }` and `required: [...]` from a JSON schema object literal. */
const fieldsFromJsonSchemaObject = (schemaObj: t.ObjectExpression, values: Map<string, string>): Array<{ name: string; type?: string; required?: boolean }> => {
  const props = collectObjectProperties(schemaObj);
  const propertiesExpr = props.get('properties');
  const requiredExpr = props.get('required');

  const requiredNames = new Set<string>();
  if (requiredExpr && t.isArrayExpression(requiredExpr)) {
    for (const element of requiredExpr.elements) {
      if (element && t.isStringLiteral(element)) {
        requiredNames.add(element.value);
      }
    }
  }

  const fields: Array<{ name: string; type?: string; required?: boolean }> = [];
  if (propertiesExpr && t.isObjectExpression(propertiesExpr)) {
    const propMap = collectObjectProperties(propertiesExpr);
    for (const [name, valueExpr] of propMap.entries()) {
      let type: string | undefined;
      if (t.isObjectExpression(valueExpr)) {
        const fieldProps = collectObjectProperties(valueExpr);
        type = jsonSchemaType(fieldProps.get('type'), values);
      }
      fields.push({ name, type: type ?? 'string', required: requiredNames.has(name) });
    }
  }
  return fields;
};

/**
 * Fastify route options: { schema: { body: {...}, querystring: {...} } }.
 * Best-effort mapping into body + queryParams.
 */
const extractFastifySchemaOption = (
  args: ReadonlyArray<t.Node>,
  values: Map<string, string>
): { body?: SchemaObject; queryParams?: SchemaField[] } => {
  const result: { body?: SchemaObject; queryParams?: SchemaField[] } = {};
  try {
    for (const arg of args) {
      if (!t.isObjectExpression(arg)) {
        continue;
      }
      const optionProps = collectObjectProperties(arg);
      const schemaExpr = optionProps.get('schema');
      if (!schemaExpr || !t.isObjectExpression(schemaExpr)) {
        continue;
      }
      const schemaProps = collectObjectProperties(schemaExpr);

      const bodyExpr = schemaProps.get('body');
      if (bodyExpr && t.isObjectExpression(bodyExpr)) {
        const body = makeBodySchema(fieldsFromJsonSchemaObject(bodyExpr, values));
        if (body) {
          result.body = body;
        }
      }

      const queryExpr = schemaProps.get('querystring') ?? schemaProps.get('query');
      if (queryExpr && t.isObjectExpression(queryExpr)) {
        const queryFields = fieldsFromJsonSchemaObject(queryExpr, values);
        if (queryFields.length) {
          result.queryParams = queryFields.map((f) => ({
            name: f.name,
            required: f.required ?? false,
            type: f.type ?? 'string'
          }));
        }
      }
    }
  } catch {
    // Defensive.
  }
  return result;
};

/**
 * Inspect a route call expression's arguments to recover body/query signals
 * from the handler function and/or a Fastify schema option object.
 */
const extractRouteCallSignals = (
  args: ReadonlyArray<t.Node>,
  values: Map<string, string>
): { body?: SchemaObject; queryParams?: SchemaField[] } => {
  const merged: { body?: SchemaObject; queryParams?: SchemaField[] } = {};

  try {
    const handler = findHandlerNode(args);
    if (handler) {
      const signals = newHandlerSignals();
      extractHandlerSignals(handler, signals);
      if (hasSignals(signals)) {
        const fields = signalsToRouteFields(signals);
        if (fields.body) {
          merged.body = fields.body;
        }
        if (fields.queryParams) {
          merged.queryParams = fields.queryParams;
        }
      }
    }

    const fastify = extractFastifySchemaOption(args, values);
    if (fastify.body && !merged.body) {
      merged.body = fastify.body;
    }
    if (fastify.queryParams && !merged.queryParams) {
      merged.queryParams = fastify.queryParams;
    }
  } catch {
    // Defensive.
  }

  return merged;
};

/** Map a TS type annotation node to our primitive type string. */
const tsTypeToPrimitive = (annotation: t.Node | null | undefined): string | undefined => {
  if (!annotation) {
    return undefined;
  }
  const node = t.isTSTypeAnnotation(annotation) ? annotation.typeAnnotation : annotation;
  if (t.isTSStringKeyword(node)) {
    return 'string';
  }
  if (t.isTSNumberKeyword(node)) {
    return 'number';
  }
  if (t.isTSBooleanKeyword(node)) {
    return 'boolean';
  }
  if (t.isTSArrayType(node)) {
    return 'array';
  }
  return undefined;
};

/** Extract class properties as body fields from an in-file DTO class declaration. */
const fieldsFromDtoClass = (
  classNode: t.ClassDeclaration
): Array<{ name: string; type?: string; required?: boolean }> => {
  const fields: Array<{ name: string; type?: string; required?: boolean }> = [];
  try {
    for (const member of classNode.body.body) {
      if (!t.isClassProperty(member)) {
        continue;
      }
      const name = getPropName(member.key);
      if (!name) {
        continue;
      }
      const type = tsTypeToPrimitive(member.typeAnnotation) ?? 'string';
      // optional property (name?: ...) => not required
      const optional = Boolean((member as { optional?: boolean }).optional);
      fields.push({ name, type, required: !optional });
    }
  } catch {
    // Defensive.
  }
  return fields;
};

/** Read the decorator name (e.g. `Body`, `Query`, `Param`) from a param decorator. */
const decoratorName = (decorator: t.Decorator): string | null => {
  const expr = decorator.expression;
  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
    return expr.callee.name;
  }
  if (t.isIdentifier(expr)) {
    return expr.name;
  }
  return null;
};

/** First string-literal argument of a decorator call, if any (e.g. @Query('q')). */
const decoratorStringArg = (decorator: t.Decorator): string | undefined => {
  const expr = decorator.expression;
  if (t.isCallExpression(expr) && expr.arguments[0] && t.isStringLiteral(expr.arguments[0])) {
    return expr.arguments[0].value;
  }
  return undefined;
};

/** TS type-reference name of a parameter (e.g. CreateUserDto), if it is a simple identifier ref. */
const paramTypeName = (param: t.Node): string | undefined => {
  const typeAnnotation = (param as { typeAnnotation?: t.TSTypeAnnotation | null }).typeAnnotation;
  if (typeAnnotation && t.isTSTypeAnnotation(typeAnnotation) && t.isTSTypeReference(typeAnnotation.typeAnnotation)) {
    const typeName = typeAnnotation.typeAnnotation.typeName;
    if (t.isIdentifier(typeName)) {
      return typeName.name;
    }
  }
  return undefined;
};

/**
 * Recover body/query/path signals from a NestJS controller method's decorated
 * parameters (@Body, @Query, @Param), resolving in-file DTO classes for bodies.
 */
const extractNestParamSignals = (
  method: t.ClassMethod,
  dtoClasses: Map<string, t.ClassDeclaration>
): { body?: SchemaObject; queryParams?: SchemaField[]; pathParams?: SchemaField[] } => {
  const result: { body?: SchemaObject; queryParams?: SchemaField[]; pathParams?: SchemaField[] } = {};
  const queryParams: SchemaField[] = [];
  const pathParams: SchemaField[] = [];

  try {
    for (const param of method.params) {
      const decorators = (param as { decorators?: t.Decorator[] | null }).decorators;
      if (!decorators?.length) {
        continue;
      }
      for (const decorator of decorators) {
        const name = decoratorName(decorator);
        if (name === 'Body') {
          const typeName = paramTypeName(param);
          const dtoClass = typeName ? dtoClasses.get(typeName) : undefined;
          if (dtoClass) {
            const fields = fieldsFromDtoClass(dtoClass);
            const body = makeBodySchema(fields);
            result.body = body ?? { type: 'object' };
          } else {
            result.body = { type: 'object' };
          }
        } else if (name === 'Query') {
          const argName = decoratorStringArg(decorator);
          if (argName) {
            queryParams.push({ name: argName, required: false, type: 'string' });
          }
        } else if (name === 'Param') {
          const argName = decoratorStringArg(decorator);
          if (argName) {
            pathParams.push({ name: argName, required: true, type: 'string' });
          }
        }
      }
    }
  } catch {
    // Defensive.
  }

  if (queryParams.length) {
    result.queryParams = queryParams;
  }
  if (pathParams.length) {
    result.pathParams = pathParams;
  }
  return result;
};

const analyzeJsFile = (file: RepoFile, allPaths: Set<string>): FileAnalysis | null => {
  if (!JS_FILE_REGEX.test(file.path)) {
    return null;
  }

  const ast = parseAst(file);
  if (!ast) {
    return null;
  }

  const values = new Map<string, string>();
  const imports = new Map<string, ImportBinding>();
  const ownerKinds = new Map<string, ApiEndpoint['source']>();
  const routes: RouteSignal[] = [];
  const mounts: MountSignal[] = [];
  const namedExports = new Map<string, string>();
  let defaultExportOwner: string | undefined;

  // Pre-collect in-file class declarations so NestJS @Body() DTOs can be resolved
  // regardless of declaration order relative to the controller.
  const dtoClasses = new Map<string, t.ClassDeclaration>();
  try {
    for (const statement of ast.program.body) {
      if (t.isClassDeclaration(statement) && statement.id) {
        dtoClasses.set(statement.id.name, statement);
      }
      if (
        t.isExportNamedDeclaration(statement) &&
        statement.declaration &&
        t.isClassDeclaration(statement.declaration) &&
        statement.declaration.id
      ) {
        dtoClasses.set(statement.declaration.id.name, statement.declaration);
      }
    }
  } catch {
    // Defensive.
  }

  const pushRoute = (route: RouteSignal) => {
    if (!HTTP_METHODS.has(route.method.toUpperCase())) {
      return;
    }
    routes.push({
      ...route,
      method: route.method.toUpperCase(),
      path: normalizePath(route.path),
      confidence: clampConfidence(route.confidence)
    });
  };

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const resolvedPath = resolveImport(file.path, source, allPaths);
      for (const specifier of path.node.specifiers) {
        if (t.isImportDefaultSpecifier(specifier)) {
          imports.set(specifier.local.name, { source, imported: 'default', resolvedPath });
          continue;
        }
        if (t.isImportSpecifier(specifier)) {
          const importedName = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          imports.set(specifier.local.name, { source, imported: importedName, resolvedPath });
          continue;
        }
        if (t.isImportNamespaceSpecifier(specifier)) {
          imports.set(specifier.local.name, { source, imported: '*', resolvedPath });
        }
      }
    },
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) {
        return;
      }

      const localName = path.node.id.name;
      if (t.isExpression(path.node.init)) {
        const resolved = toStringValue(path.node.init, values);
        if (resolved !== undefined) {
          values.set(localName, resolved);
        }
      }

      if (!path.node.init) {
        return;
      }

      if (t.isIdentifier(path.node.init) && ownerKinds.has(path.node.init.name)) {
        ownerKinds.set(localName, ownerKinds.get(path.node.init.name)!);
      }

      if (t.isCallExpression(path.node.init)) {
        const call = path.node.init;

        if (t.isIdentifier(call.callee)) {
          const binding = imports.get(call.callee.name);
          if (binding?.source && FASTIFY_IMPORTS.has(binding.source)) {
            ownerKinds.set(localName, 'fastify');
          }
          if (call.callee.name === 'Router' && binding?.source && KOA_IMPORTS.has(binding.source)) {
            ownerKinds.set(localName, 'koa');
          }
          if (call.callee.name === 'Router' && binding?.source && EXPRESS_IMPORTS.has(binding.source)) {
            ownerKinds.set(localName, 'express');
          }
        }

        if (t.isMemberExpression(call.callee)) {
          const property = getPropName(call.callee.property);
          if (property === 'Router') {
            ownerKinds.set(localName, 'express');
          }
        }
      }

      if (t.isNewExpression(path.node.init) && t.isIdentifier(path.node.init.callee)) {
        const binding = imports.get(path.node.init.callee.name);
        if (binding?.source && KOA_IMPORTS.has(binding.source)) {
          ownerKinds.set(localName, 'koa');
        }
        if (binding?.source && HONO_IMPORTS.has(binding.source)) {
          ownerKinds.set(localName, 'hono');
        }
      }
    },
    AssignmentExpression(path) {
      if (!t.isMemberExpression(path.node.left)) {
        return;
      }
      const leftObject = path.node.left.object;
      const leftProperty = path.node.left.property;

      if (
        t.isMemberExpression(leftObject) &&
        t.isIdentifier(leftObject.object, { name: 'module' }) &&
        t.isIdentifier(leftObject.property, { name: 'exports' }) &&
        t.isIdentifier(leftProperty) &&
        t.isIdentifier(path.node.right)
      ) {
        namedExports.set(leftProperty.name, path.node.right.name);
      }

      if (
        t.isIdentifier(leftObject, { name: 'module' }) &&
        t.isIdentifier(leftProperty, { name: 'exports' }) &&
        t.isIdentifier(path.node.right)
      ) {
        defaultExportOwner = path.node.right.name;
      }

      if (t.isIdentifier(leftObject, { name: 'exports' }) && t.isIdentifier(leftProperty) && t.isIdentifier(path.node.right)) {
        namedExports.set(leftProperty.name, path.node.right.name);
      }
    },
    ExportDefaultDeclaration(path) {
      if (t.isIdentifier(path.node.declaration)) {
        defaultExportOwner = path.node.declaration.name;
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.declaration && t.isVariableDeclaration(path.node.declaration)) {
        for (const declaration of path.node.declaration.declarations) {
          if (t.isIdentifier(declaration.id)) {
            namedExports.set(declaration.id.name, declaration.id.name);
          }
        }
      }

      if (path.node.declaration && t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
        namedExports.set(path.node.declaration.id.name, path.node.declaration.id.name);
      }

      for (const specifier of path.node.specifiers) {
        if (t.isExportSpecifier(specifier)) {
          const local = specifier.local.name;
          const exported = t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value;
          namedExports.set(exported, local);
        }
      }
    },
    ClassDeclaration(path) {
      if (!path.node.decorators?.length) {
        return;
      }

      const controllerDecorator = path.node.decorators.find((decorator) => {
        if (!t.isCallExpression(decorator.expression)) {
          return false;
        }
        return t.isIdentifier(decorator.expression.callee, { name: 'Controller' });
      });

      if (!controllerDecorator || !t.isCallExpression(controllerDecorator.expression)) {
        return;
      }

      const prefix = toStringValue(controllerDecorator.expression.arguments[0] as Expression | undefined, values) ?? '';
      const classBody = path.node.body.body;

      for (const member of classBody) {
        if (!t.isClassMethod(member) || !member.decorators?.length) {
          continue;
        }
        const routeDecorator = member.decorators.find((decorator) => {
          if (!t.isCallExpression(decorator.expression) || !t.isIdentifier(decorator.expression.callee)) {
            return false;
          }
          return methodFromDecorator(decorator.expression.callee.name) !== null;
        });
        if (!routeDecorator || !t.isCallExpression(routeDecorator.expression) || !t.isIdentifier(routeDecorator.expression.callee)) {
          continue;
        }
        const method = methodFromDecorator(routeDecorator.expression.callee.name);
        if (!method) {
          continue;
        }
        const suffix = toStringValue(routeDecorator.expression.arguments[0] as Expression | undefined, values) ?? '';
        const fullPath = joinPath(prefix, suffix);
        const { body, queryParams, pathParams } = extractNestParamSignals(member, dtoClasses);
        pushRoute({
          method,
          path: fullPath,
          source: 'nestjs',
          owner: path.node.id?.name ?? 'controller',
          file,
          confidence: 0.95,
          evidence: [makeEvidence(file, `NestJS @${routeDecorator.expression.callee.name} route`, member.start ?? undefined)],
          body,
          queryParams,
          pathParams
        });
      }
    },
    CallExpression(path) {
      const expression = path.node;
      routeFromObjectPattern(expression, file, values, ownerKinds, imports, routes);
      routeFromChainedRouteCall(expression, file, values, ownerKinds, imports, routes);

      if (!t.isMemberExpression(expression.callee)) {
        return;
      }

      const ownerName = t.isIdentifier(expression.callee.object) ? expression.callee.object.name : undefined;
      const methodName = getPropName(expression.callee.property);
      if (!ownerName || !methodName) {
        return;
      }

      if (methodName === 'use') {
        if (expression.arguments.length < 2) {
          return;
        }
        const prefix = toStringValue(expression.arguments[0] as Expression | undefined, values);
        const target = expression.arguments[1];
        if (!prefix || !target) {
          return;
        }

        let childOwner: string | undefined;
        if (t.isIdentifier(target)) {
          childOwner = target.name;
        } else if (
          t.isCallExpression(target) &&
          t.isMemberExpression(target.callee) &&
          t.isIdentifier(target.callee.object) &&
          getPropName(target.callee.property) === 'routes'
        ) {
          childOwner = target.callee.object.name;
        }

        if (childOwner) {
          mounts.push({
            file,
            parentOwner: ownerName,
            childOwner,
            prefix: normalizePath(prefix),
            confidencePenalty: 0.06,
            evidence: makeEvidence(file, `mounted router with ${methodName}()`, expression.start ?? undefined)
          });
        }
        return;
      }

      if (!HTTP_METHODS.has(methodName.toUpperCase())) {
        return;
      }

      const source = inferSourceForOwner(ownerName, ownerKinds, imports);
      if (!source) {
        return;
      }

      const pathArg = expression.arguments[0];
      const routePath = toStringValue(pathArg as Expression | undefined, values);
      if (!routePath) {
        return;
      }

      const routeEvidence = makeEvidence(file, `${source} ${methodName.toUpperCase()} route`, expression.start ?? undefined);
      const confidence = source === 'express' || source === 'fastify' || source === 'koa' || source === 'hono' ? 0.9 : 0.85;
      const { body, queryParams } = extractRouteCallSignals(expression.arguments, values);
      pushRoute({
        method: methodName.toUpperCase(),
        path: routePath,
        owner: ownerName,
        source,
        file,
        confidence,
        evidence: [routeEvidence],
        body,
        queryParams
      });
    }
  });

  const nextPath = parseNextPathFromFile(file.path);
  if (nextPath) {
    const nextAst = parseAst(file);
    if (nextAst) {
      const exportedMethods = new Set<string>();
      traverse(nextAst, {
        ExportNamedDeclaration(path) {
          if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
            const method = path.node.declaration.id.name.toUpperCase();
            if (HTTP_METHODS.has(method)) {
              exportedMethods.add(method);
            }
          }
          if (t.isVariableDeclaration(path.node.declaration)) {
            for (const decl of path.node.declaration.declarations) {
              if (t.isIdentifier(decl.id)) {
                const method = decl.id.name.toUpperCase();
                if (HTTP_METHODS.has(method)) {
                  exportedMethods.add(method);
                }
              }
            }
          }
        }
      });

      if (!exportedMethods.size && /pages\/api\//i.test(file.path)) {
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          const regex = new RegExp(`req\\.method\\s*===\\s*['"]${method}['"]`, 'i');
          if (regex.test(file.content)) {
            exportedMethods.add(method);
          }
        }
      }

      for (const method of exportedMethods) {
        pushRoute({
          method,
          path: nextPath,
          owner: '__next__',
          source: 'nextjs',
          file,
          confidence: /pages\/api\//i.test(file.path) ? 0.8 : 0.94,
          evidence: [makeEvidence(file, 'Next.js route handler export', 0)]
        });
      }
    }
  }

  return {
    file,
    imports,
    routes,
    mounts,
    ownerKind: ownerKinds,
    namedExports,
    defaultExportOwner
  };
};

const pickImportedRoutes = (
  analysesByPath: Map<string, FileAnalysis>,
  routeSignals: RouteSignal[],
  mount: MountSignal,
  binding: ImportBinding
): RouteSignal[] => {
  if (!binding.resolvedPath) {
    return [];
  }
  const targetAnalysis = analysesByPath.get(binding.resolvedPath);
  if (!targetAnalysis) {
    return [];
  }

  if (binding.imported === 'default') {
    if (targetAnalysis.defaultExportOwner) {
      return routeSignals.filter(
        (route) => route.file.path === binding.resolvedPath && route.owner === targetAnalysis.defaultExportOwner
      );
    }
    return routeSignals.filter((route) => route.file.path === binding.resolvedPath);
  }

  if (binding.imported === '*') {
    return routeSignals.filter((route) => route.file.path === binding.resolvedPath);
  }

  const owner = targetAnalysis.namedExports.get(binding.imported);
  if (owner) {
    return routeSignals.filter((route) => route.file.path === binding.resolvedPath && route.owner === owner);
  }

  return routeSignals.filter((route) => route.file.path === binding.resolvedPath);
};

const applyMounts = (analyses: FileAnalysis[]): RouteSignal[] => {
  const analysisByPath = new Map<string, FileAnalysis>(analyses.map((analysis) => [analysis.file.path, analysis]));
  const known = [...analyses.flatMap((analysis) => analysis.routes)];
  const dedupe = new Set(known.map((route) => `${route.file.path}|${route.owner}|${route.method}|${route.path}|${route.source}`));

  for (let round = 0; round < 5; round += 1) {
    let added = false;

    for (const analysis of analyses) {
      for (const mount of analysis.mounts) {
        const localChildRoutes = known.filter(
          (route) => route.file.path === mount.file.path && route.owner === mount.childOwner
        );
        const binding = analysis.imports.get(mount.childOwner);
        const importedChildRoutes = binding
          ? pickImportedRoutes(analysisByPath, known, mount, binding)
          : [];
        const candidates = [...localChildRoutes, ...importedChildRoutes];

        for (const child of candidates) {
          const nextPath = child.path === '/' ? mount.prefix : joinPath(mount.prefix, child.path);
          const next: RouteSignal = {
            ...child,
            owner: mount.parentOwner,
            file: mount.file,
            path: nextPath,
            confidence: clampConfidence(child.confidence - mount.confidencePenalty),
            evidence: [...child.evidence, mount.evidence]
          };
          const key = `${next.file.path}|${next.owner}|${next.method}|${next.path}|${next.source}`;
          if (dedupe.has(key)) {
            continue;
          }
          dedupe.add(key);
          known.push(next);
          added = true;
        }
      }
    }

    if (!added) {
      break;
    }
  }

  return known;
};

const inferAuthMetadata = (content: string): { auth: ApiEndpoint['auth']; authHints?: ApiEndpoint['authHints'] } => {
  const hints: NonNullable<ApiEndpoint['authHints']> = [];
  const lower = content.toLowerCase();

  if (/oauth|openid|passport|auth0/.test(lower)) {
    hints.push({
      type: 'oauth2',
      headerName: 'Authorization',
      setupSteps: ['Provide API_TOKEN for OAuth-protected endpoints.'],
      confidence: 0.8,
      evidence: 'Source code references OAuth/OpenID auth.'
    });
  }

  if (/authorization|bearer|jwt|token|guard/.test(lower)) {
    hints.push({
      type: hints.length ? hints[0].type : 'bearer',
      headerName: 'Authorization',
      setupSteps: ['Provide API_TOKEN for authenticated requests.'],
      confidence: 0.72,
      evidence: 'Source code references token/bearer auth.'
    });
  }

  const apiKeyHeaderMatch = content.match(/\b(X-[A-Za-z-]*API[-_]KEY|X-API-KEY|api-key)\b/i);
  if (apiKeyHeaderMatch) {
    hints.push({
      type: 'apiKey',
      headerName: apiKeyHeaderMatch[1],
      setupSteps: ['Provide API_KEY for authenticated requests.'],
      confidence: 0.78,
      evidence: 'Source code references API key headers.'
    });
  }

  if (/cookie|set-cookie|express-session|req\.session|session/.test(lower)) {
    hints.push({
      type: 'cookieSession',
      cookieName: 'session',
      setupSteps: ['Provide SESSION_COOKIE during validation when session auth is required.'],
      confidence: 0.7,
      evidence: 'Source code references cookies/session state.'
    });
  }

  if (/csrf|xsrf/.test(lower)) {
    hints.push({
      type: 'csrf',
      csrfHeaderName: 'X-CSRF-Token',
      setupSteps: ['Provide CSRF_TOKEN for mutating requests protected by CSRF middleware.'],
      confidence: 0.68,
      evidence: 'Source code references CSRF/XSRF protection.'
    });
  }

  const auth = hints[0]?.type ?? 'unknown';
  return {
    auth,
    authHints: hints.length ? hints : undefined
  };
};

const toApiEndpoints = (signals: RouteSignal[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const key = `${signal.source}|${signal.method}|${signal.path}|${signal.file.path}|${signal.owner}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const { auth, authHints } = inferAuthMetadata(signal.file.content);
    const authHeaders = authHints?.length
      ? Object.fromEntries(
          authHints
            .filter((hint) => hint.headerName)
            .map((hint) => [hint.headerName!, hint.type === 'apiKey' ? '{{API_KEY}}' : 'Bearer {{API_TOKEN}}'])
        )
      : undefined;
    const exampleQuery = signal.queryParams?.length
      ? Object.fromEntries(signal.queryParams.map((param) => [param.name, param.example ?? sampleForType(param.type)]))
      : undefined;
    const exampleBody = signal.body ? exampleFromSchema(signal.body) : undefined;
    const hasExample = Boolean(authHeaders || exampleQuery || exampleBody !== undefined);
    endpoints.push(
      buildEndpoint({
        method: signal.method,
        path: signal.path,
        source: signal.source,
        file: signal.file,
        auth,
        authHints,
        confidence: signal.confidence,
        evidence: signal.evidence,
        summary: signal.summary,
        pathParams: signal.pathParams,
        queryParams: signal.queryParams,
        body: signal.body,
        responses: signal.responses,
        examples: hasExample
          ? [{
              origin: 'code',
              request: {
                ...(authHeaders ? { headers: authHeaders } : {}),
                ...(exampleQuery ? { query: exampleQuery } : {}),
                ...(exampleBody !== undefined ? { body: exampleBody } : {})
              },
              note: 'Request shape inferred from source code.'
            }]
          : undefined
      })
    );
  }
  return endpoints;
};

export const parseCodeRoutes = (files: RepoFile[]): ApiEndpoint[] => {
  const pathSet = new Set(files.map((file) => file.path));
  const analyses = files
    .map((file) => analyzeJsFile(file, pathSet))
    .filter((item): item is FileAnalysis => Boolean(item));

  const mountedSignals = applyMounts(analyses);
  const pythonSignals = parsePythonRoutes(files);
  const goSignals = parseGoRoutes(files);
  const springSignals = parseSpringRoutes(files);

  return toApiEndpoints([...mountedSignals, ...pythonSignals, ...goSignals, ...springSignals]);
};
