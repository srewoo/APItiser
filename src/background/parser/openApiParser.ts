import { parse as parseYaml } from 'yaml';
import type { ApiEndpoint, RepoFile, SchemaField, SchemaObject } from '@shared/types';
import { buildEndpoint, makeEvidence } from './endpointBuilder';

const OPENAPI_FILE_REGEX = /(openapi|swagger)/i;
const OPENAPI_HINT_REGEX = /(?:"openapi"\s*:|"swagger"\s*:|\bopenapi\s*:|\bswagger\s*:)/i;
const PATHS_HINT_REGEX = /(?:"paths"\s*:|\bpaths\s*:)/i;
const SERIALIZED_SPEC_EXT_REGEX = /\.(json|ya?ml)$/i;

const normalizeSchemaField = (name: string, source: Record<string, unknown>, required = false): SchemaField => ({
  name,
  required,
  type: String(source.type ?? 'string'),
  format: source.format ? String(source.format) : undefined,
  description: source.description ? String(source.description) : undefined
});

/**
 * Resolves a JSON Pointer `$ref` (local only, e.g. `#/components/schemas/Pet`)
 * against the root document. Returns the referenced object or undefined if not found.
 */
const resolveRef = (ref: string, document: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  const parts = ref.slice(2).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = document;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : undefined;
};

const parseSchema = (schema: unknown, document?: Record<string, unknown>): SchemaObject | undefined => {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  const source = schema as Record<string, unknown>;

  // Resolve $ref if present and document is provided
  if (typeof source.$ref === 'string' && document) {
    const resolved = resolveRef(source.$ref, document);
    if (resolved) {
      return parseSchema(resolved, document);
    }
    return undefined;
  }

  const parsed: SchemaObject = {
    type: String(source.type ?? 'object'),
    description: source.description ? String(source.description) : undefined
  };

  if (Array.isArray(source.required)) {
    parsed.required = source.required.map(String);
  }

  if (source.properties && typeof source.properties === 'object') {
    parsed.properties = {};
    for (const [key, value] of Object.entries(source.properties as Record<string, unknown>)) {
      parsed.properties[key] = parseSchema(value, document) ?? normalizeSchemaField(key, value as Record<string, unknown>);
    }
  }

  if (source.items && typeof source.items === 'object') {
    parsed.items = parseSchema(source.items, document);
  }

  return parsed;
};

const parseDocument = (content: string, path: string): Record<string, unknown> | null => {
  try {
    if (path.endsWith('.json')) {
      return JSON.parse(content) as Record<string, unknown>;
    }
    return parseYaml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isCandidateOpenApiFile = (file: RepoFile): boolean => {
  if (!SERIALIZED_SPEC_EXT_REGEX.test(file.path)) {
    return false;
  }

  if (OPENAPI_FILE_REGEX.test(file.path)) {
    return true;
  }

  const start = file.content.slice(0, 30000);
  return OPENAPI_HINT_REGEX.test(start) && PATHS_HINT_REGEX.test(start);
};

const confidenceForFile = (filePath: string): number => (OPENAPI_FILE_REGEX.test(filePath) ? 0.98 : 0.91);

export const parseOpenApiSpecs = (files: RepoFile[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];

  for (const file of files) {
    if (!isCandidateOpenApiFile(file)) {
      continue;
    }

    const document = parseDocument(file.content, file.path);
    if (!document?.paths || typeof document.paths !== 'object') {
      continue;
    }

    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    for (const [pathKey, operations] of Object.entries(paths)) {
      for (const [methodKey, operation] of Object.entries(operations)) {
        const method = methodKey.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
          continue;
        }

        // Resolve operation-level $ref if present
        const resolvedOp = typeof operation.$ref === 'string'
          ? (resolveRef(operation.$ref, document) ?? operation)
          : operation;

        const parameters = Array.isArray(resolvedOp.parameters)
          ? (resolvedOp.parameters as Record<string, unknown>[])
          : [];

        const pathParams = parameters
          .filter((item) => item.in === 'path')
          .map((item) => {
            const schema = typeof item.schema === 'object' && item.schema !== null && typeof (item.schema as Record<string, unknown>).$ref === 'string'
              ? (resolveRef((item.schema as Record<string, unknown>).$ref as string, document) ?? item.schema)
              : item.schema;
            return normalizeSchemaField(String(item.name ?? 'param'), (schema ?? {}) as Record<string, unknown>, Boolean(item.required));
          });

        const queryParams = parameters
          .filter((item) => item.in === 'query')
          .map((item) => {
            const schema = typeof item.schema === 'object' && item.schema !== null && typeof (item.schema as Record<string, unknown>).$ref === 'string'
              ? (resolveRef((item.schema as Record<string, unknown>).$ref as string, document) ?? item.schema)
              : item.schema;
            return normalizeSchemaField(String(item.name ?? 'query'), (schema ?? {}) as Record<string, unknown>, Boolean(item.required));
          });

        const requestBody = resolvedOp.requestBody as Record<string, unknown> | undefined;
        const jsonBodySchema = requestBody?.content && typeof requestBody.content === 'object'
          ? ((requestBody.content as Record<string, Record<string, unknown>>)['application/json']?.schema as Record<string, unknown> | undefined)
          : undefined;

        // Resolve $ref in request body schema
        const resolvedBodySchema = jsonBodySchema && typeof jsonBodySchema.$ref === 'string'
          ? (resolveRef(jsonBodySchema.$ref, document) ?? jsonBodySchema)
          : jsonBodySchema;

        const responsesRaw = resolvedOp.responses as Record<string, Record<string, unknown>> | undefined;
        const responses = responsesRaw
          ? Object.entries(responsesRaw).map(([status, detail]) => ({
              status,
              description: detail.description ? String(detail.description) : undefined
            }))
          : [{ status: '200' }];

        endpoints.push(
          buildEndpoint({
            method,
            path: pathKey,
            source: 'openapi',
            file,
            confidence: confidenceForFile(file.path),
            evidence: [makeEvidence(file, 'OpenAPI/Swagger spec path operation')],
            operationId: resolvedOp.operationId ? String(resolvedOp.operationId) : undefined,
            summary: resolvedOp.summary ? String(resolvedOp.summary) : undefined,
            description: resolvedOp.description ? String(resolvedOp.description) : undefined,
            auth: Array.isArray(resolvedOp.security) && resolvedOp.security.length > 0 ? 'bearer' : 'unknown',
            pathParams,
            queryParams,
            body: parseSchema(resolvedBodySchema, document),
            responses
          })
        );
      }
    }
  }

  return endpoints;
};
