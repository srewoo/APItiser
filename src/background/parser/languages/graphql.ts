import type { ApiEndpoint, RepoFile, SchemaObject } from '@shared/types';
import { buildEndpoint, makeEvidence } from '../endpointBuilder';

/**
 * GraphQL schema-first detection. GraphQL is HTTP-testable: every operation is a `POST /graphql`
 * with a `{ query, variables }` body. We surface each root field of `type Query`, `type Mutation`,
 * and `type Subscription` as its own endpoint so the generator can exercise them individually.
 *
 * This is a lightweight SDL scan (not a full GraphQL parser) — it reads dedicated `.graphql`/`.gql`
 * files and inline SDL / `gql\`…\`` templates embedded in JS/TS. It intentionally does NOT try to
 * build a complete selection set (that needs return-type resolution); it emits a minimal, valid-shaped
 * operation scaffold plus the field signature so the LLM can complete a real query.
 */

const OPERATION_TYPES: Array<{ typeName: string; opKeyword: 'query' | 'mutation' | 'subscription' }> = [
  { typeName: 'Query', opKeyword: 'query' },
  { typeName: 'Mutation', opKeyword: 'mutation' },
  { typeName: 'Subscription', opKeyword: 'subscription' }
];

const GRAPHQL_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { name: 'query', type: 'string', required: true, description: 'GraphQL operation document' },
    variables: { type: 'object', description: 'Operation variables' }
  }
};

/** Extract the `{ … }` body of `type <Name> { … }`, tolerating nested braces. */
const extractTypeBody = (content: string, typeName: string): string | null => {
  const header = new RegExp(`\\btype\\s+${typeName}\\b[^{]*\\{`, 'm');
  const match = header.exec(content);
  if (!match) return null;
  let depth = 0;
  const open = match.index + match[0].length - 1;
  for (let i = open; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    else if (content[i] === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return null;
};

interface GraphQLField {
  name: string;
  args: string;
  returnType: string;
}

/** Parse `fieldName(arg: T, …): ReturnType` field definitions from a type body. */
const parseFields = (body: string): GraphQLField[] => {
  const fields: GraphQLField[] = [];
  // Strip block/line comments and descriptions to reduce false matches.
  const cleaned = body.replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  for (const match of cleaned.matchAll(/(\w+)\s*(\([^)]*\))?\s*:\s*([\w![\]]+)/g)) {
    fields.push({ name: match[1], args: (match[2] ?? '').trim(), returnType: match[3] });
  }
  return fields;
};

const looksLikeGraphQL = (file: RepoFile): boolean =>
  /\.(graphql|gql)$/i.test(file.path) ||
  /\btype\s+(Query|Mutation|Subscription)\b/.test(file.content) ||
  /\bgql\s*`/.test(file.content);

export const parseGraphQLEndpoints = (files: RepoFile[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!looksLikeGraphQL(file)) continue;

    for (const { typeName, opKeyword } of OPERATION_TYPES) {
      const body = extractTypeBody(file.content, typeName);
      if (!body) continue;

      for (const field of parseFields(body)) {
        const dedupeKey = `${opKeyword}:${field.name}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const signature = `${field.name}${field.args}: ${field.returnType}`;
        // Minimal, syntactically valid scaffold. The generator refines the selection set.
        const queryDoc = `${opKeyword} { ${field.name} }`;
        const endpoint = buildEndpoint({
          method: 'POST',
          path: '/graphql',
          source: 'graphql',
          file,
          operationId: field.name,
          summary: `GraphQL ${opKeyword} ${field.name}`,
          description: `GraphQL ${opKeyword} field: ${signature}`,
          confidence: 0.8,
          evidence: [makeEvidence(file, `GraphQL ${typeName}.${field.name}`, file.content.indexOf(field.name))],
          body: GRAPHQL_BODY_SCHEMA,
          responses: [{ status: '200' }, { status: '400' }],
          examples: [
            {
              origin: 'code',
              request: { body: { query: queryDoc } },
              note: `Refine the selection set for ${field.returnType}. Fill variables for ${field.args || 'no args'}.`
            }
          ]
        });
        // GraphQL ops share POST /graphql, so the method+path id is not unique — qualify it.
        endpoints.push({ ...endpoint, id: `${endpoint.id}::${opKeyword}:${field.name}` });
      }
    }
  }

  return endpoints;
};
