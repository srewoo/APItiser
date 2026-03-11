import { parse } from '@babel/parser';
import type { Expression, File, ObjectExpression } from '@babel/types';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { ApiEndpoint, EndpointEvidence, RepoFile } from '@shared/types';
import { buildEndpoint, clampConfidence, joinPath, makeEvidence, normalizePath } from './endpointBuilder';

const JS_FILE_REGEX = /\.(?:[cm]?[jt]sx?)$/i;
const PY_FILE_REGEX = /\.py$/i;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const EXPRESS_IMPORTS = new Set(['express']);
const FASTIFY_IMPORTS = new Set(['fastify']);
const KOA_IMPORTS = new Set(['koa-router', '@koa/router']);
const HONO_IMPORTS = new Set(['hono']);

interface ImportBinding {
  source: string;
  imported: string;
  resolvedPath?: string;
}

interface RouteSignal {
  method: string;
  path: string;
  source: ApiEndpoint['source'];
  owner: string;
  file: RepoFile;
  confidence: number;
  evidence: EndpointEvidence[];
}

interface MountSignal {
  file: RepoFile;
  parentOwner: string;
  childOwner: string;
  prefix: string;
  confidencePenalty: number;
  evidence: EndpointEvidence;
}

interface FileAnalysis {
  file: RepoFile;
  imports: Map<string, ImportBinding>;
  routes: RouteSignal[];
  mounts: MountSignal[];
  ownerKind: Map<string, ApiEndpoint['source']>;
  namedExports: Map<string, string>;
  defaultExportOwner?: string;
}

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
      evidence: [makeEvidence(file, 'fastify.route() declaration', expression.start ?? undefined)]
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

  routes.push({
    method: chainedMethod,
    path: normalizePath(routePath),
    owner: ownerName,
    source,
    file,
    confidence: 0.93,
    evidence: [makeEvidence(file, `express chained route ${chainedMethod}`, expression.start ?? undefined)]
  });
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
        pushRoute({
          method,
          path: fullPath,
          source: 'nestjs',
          owner: path.node.id?.name ?? 'controller',
          file,
          confidence: 0.95,
          evidence: [makeEvidence(file, `NestJS @${routeDecorator.expression.callee.name} route`, member.start ?? undefined)]
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
      pushRoute({
        method: methodName.toUpperCase(),
        path: routePath,
        owner: ownerName,
        source,
        file,
        confidence,
        evidence: [routeEvidence]
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

const parsePythonRoutes = (files: RepoFile[]): RouteSignal[] => {
  const routes: RouteSignal[] = [];

  for (const file of files) {
    if (!PY_FILE_REGEX.test(file.path)) {
      continue;
    }

    const isFastApi = /from\s+fastapi\s+import|FastAPI\s*\(/i.test(file.content);
    const source: ApiEndpoint['source'] = isFastApi ? 'fastapi' : 'flask';

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

const toApiEndpoints = (signals: RouteSignal[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const key = `${signal.source}|${signal.method}|${signal.path}|${signal.file.path}|${signal.owner}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const auth: ApiEndpoint['auth'] = /auth|token|bearer|guard/i.test(signal.file.content) ? 'bearer' : 'unknown';
    endpoints.push(
      buildEndpoint({
        method: signal.method,
        path: signal.path,
        source: signal.source,
        file: signal.file,
        auth,
        confidence: signal.confidence,
        evidence: signal.evidence
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

  return toApiEndpoints([...mountedSignals, ...pythonSignals]);
};
