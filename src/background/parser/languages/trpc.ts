import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { ApiEndpoint, RepoFile } from '@shared/types';
import { buildEndpoint, makeBodySchema, makeEvidence } from '../endpointBuilder';

/**
 * tRPC router detection. tRPC procedures are exposed over HTTP by the tRPC server adapter:
 *   - `.query(…)`  → `GET  /trpc/<procedure.path>`  (input encoded as the `input` query param)
 *   - `.mutation(…)` → `POST /trpc/<procedure.path>` (input as JSON body)
 * The procedure path is the dotted key path through nested `router({ … })` calls.
 *
 * We use the Babel AST (already a dependency) to walk router objects and recover a simple
 * `.input(z.object({ … }))` shape into query params (queries) or a body schema (mutations).
 * Resilient: any parse/traverse failure yields no endpoints rather than throwing.
 */

const isRouterCall = (node: t.Node): node is t.CallExpression => {
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  if (t.isIdentifier(callee) && callee.name === 'router') return true;
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property) && callee.property.name === 'router') return true;
  return false;
};

const keyName = (key: t.Node): string | null => {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  return null;
};

interface ProcedureChain {
  kind: 'query' | 'mutation';
  inputObject?: t.ObjectExpression;
}

/** Detect a `<builder>.input(…).query|mutation(…)` chain and recover its terminal kind + input. */
const analyzeChain = (node: t.Node): ProcedureChain | null => {
  if (!t.isCallExpression(node)) return null;
  const callee = node.callee;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return null;
  const terminal = callee.property.name;
  if (terminal !== 'query' && terminal !== 'mutation') return null;

  let inputObject: t.ObjectExpression | undefined;
  // Walk down the object chain looking for `.input(z.object({…}))`.
  let cursor: t.Node = callee.object;
  while (t.isCallExpression(cursor) && t.isMemberExpression(cursor.callee)) {
    if (t.isIdentifier(cursor.callee.property) && cursor.callee.property.name === 'input') {
      const arg = cursor.arguments[0];
      if (arg && t.isCallExpression(arg) && arg.arguments[0] && t.isObjectExpression(arg.arguments[0])) {
        inputObject = arg.arguments[0];
      }
    }
    cursor = cursor.callee.object;
  }

  return { kind: terminal, inputObject };
};

const zodType = (node: t.Node): string => {
  // z.string() → string, z.number() → integer, z.boolean() → boolean, z.array(...) → array.
  let cursor: t.Node = node;
  while (t.isCallExpression(cursor) && t.isMemberExpression(cursor.callee)) {
    if (t.isIdentifier(cursor.callee.property)) {
      const name = cursor.callee.property.name;
      if (name === 'string') return 'string';
      if (name === 'number' || name === 'int') return 'integer';
      if (name === 'boolean') return 'boolean';
      if (name === 'array') return 'array';
      if (name === 'object') return 'object';
    }
    cursor = cursor.callee.object;
  }
  return 'string';
};

/** A `z.….optional()` / `.nullish()` chain marks a non-required field. */
const isOptionalChain = (node: t.Node): boolean => {
  let cursor: t.Node = node;
  while (t.isCallExpression(cursor) && t.isMemberExpression(cursor.callee)) {
    if (t.isIdentifier(cursor.callee.property) && (cursor.callee.property.name === 'optional' || cursor.callee.property.name === 'nullish')) {
      return true;
    }
    cursor = cursor.callee.object;
  }
  return false;
};

const inputFields = (obj?: t.ObjectExpression): Array<{ name: string; type: string; required: boolean }> => {
  if (!obj) return [];
  const fields: Array<{ name: string; type: string; required: boolean }> = [];
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const name = keyName(prop.key);
    if (!name) continue;
    fields.push({ name, type: zodType(prop.value), required: !isOptionalChain(prop.value) });
  }
  return fields;
};

export const parseTrpcEndpoints = (files: RepoFile[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];

  for (const file of files) {
    if (!/\.(ts|tsx)$/i.test(file.path)) continue;
    if (!/\brouter\s*\(/.test(file.content) || !/\.(query|mutation)\s*\(/.test(file.content)) continue;

    let ast;
    try {
      ast = parse(file.content, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['typescript', 'jsx', 'decorators-legacy'] });
    } catch {
      continue;
    }

    const rootRouters: t.ObjectExpression[] = [];
    try {
      traverse(ast, {
        CallExpression(path) {
          if (!isRouterCall(path.node)) return;
          // Only treat as a root if not nested inside another router() call.
          if (path.findParent((p) => isRouterCall(p.node))) return;
          const arg = path.node.arguments[0];
          if (arg && t.isObjectExpression(arg)) rootRouters.push(arg);
        }
      });
    } catch {
      continue;
    }

    const seen = new Set<string>();
    const walk = (obj: t.ObjectExpression, prefix: string[]): void => {
      for (const prop of obj.properties) {
        if (!t.isObjectProperty(prop)) continue;
        const key = keyName(prop.key);
        if (!key) continue;

        if (isRouterCall(prop.value)) {
          const arg = (prop.value as t.CallExpression).arguments[0];
          if (arg && t.isObjectExpression(arg)) walk(arg, [...prefix, key]);
          continue;
        }

        const chain = analyzeChain(prop.value);
        if (!chain) continue;

        const procPath = [...prefix, key].join('.');
        if (seen.has(procPath)) continue;
        seen.add(procPath);

        const fields = inputFields(chain.inputObject);
        const isQuery = chain.kind === 'query';
        endpoints.push(
          buildEndpoint({
            method: isQuery ? 'GET' : 'POST',
            path: `/trpc/${procPath}`,
            source: 'trpc',
            file,
            operationId: procPath,
            summary: `tRPC ${chain.kind} ${procPath}`,
            description: `tRPC ${chain.kind} procedure ${procPath}`,
            confidence: 0.8,
            evidence: [makeEvidence(file, `tRPC ${chain.kind} ${procPath}`, file.content.indexOf(key))],
            queryParams: isQuery
              ? [
                  { name: 'input', required: false, type: 'string', description: 'JSON-encoded tRPC input' },
                  ...fields.map((f) => ({ name: f.name, required: f.required, type: f.type }))
                ]
              : [],
            body: isQuery ? undefined : makeBodySchema(fields),
            responses: [{ status: '200' }, { status: '400' }]
          })
        );
      }
    };

    for (const router of rootRouters) walk(router, []);
  }

  return endpoints;
};
