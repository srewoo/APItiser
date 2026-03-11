import { parse as parseYaml } from 'yaml';
import type { ApiEndpoint, AuthHint, RepoFile, SchemaField, SchemaObject } from '@shared/types';
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
  description: source.description ? String(source.description) : undefined,
  example: source.example
});

const toParameterList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];

const resolveSchemaRef = (value: unknown, rootSpec: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  if (typeof source.$ref === 'string') {
    return resolveRef(source.$ref, rootSpec) ?? source;
  }

  return source;
};

const mergeParameters = (
  pathLevel: Record<string, unknown>[],
  operationLevel: Record<string, unknown>[]
): Record<string, unknown>[] => {
  const merged = new Map<string, Record<string, unknown>>();

  for (const parameter of [...pathLevel, ...operationLevel]) {
    const key = `${String(parameter.in ?? 'unknown')}:${String(parameter.name ?? 'param')}`;
    merged.set(key, parameter);
  }

  return [...merged.values()];
};

const inferAuthFromSecurity = (security: unknown, rootSpec: Record<string, unknown>): ApiEndpoint['auth'] => {
  if (!Array.isArray(security)) {
    return 'unknown';
  }

  if (security.length === 0) {
    return 'none';
  }

  const schemes = ((rootSpec.components as Record<string, unknown> | undefined)?.securitySchemes ??
    {}) as Record<string, Record<string, unknown>>;
  let inferred: ApiEndpoint['auth'] = 'unknown';

  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object') {
      continue;
    }

    for (const schemeName of Object.keys(requirement as Record<string, unknown>)) {
      const scheme = schemes[schemeName];
      const type = String(scheme?.type ?? '').toLowerCase();
      const schemeNameValue = String(scheme?.scheme ?? '').toLowerCase();

      if (type === 'apikey') {
        return 'apiKey';
      }

      if (type === 'oauth2' || type === 'openidconnect' || (type === 'http' && schemeNameValue === 'bearer')) {
        inferred = 'bearer';
      }
    }
  }

  return inferred === 'unknown' ? 'bearer' : inferred;
};

const inferAuthHintsFromSecurity = (security: unknown, rootSpec: Record<string, unknown>): AuthHint[] => {
  if (!Array.isArray(security) || security.length === 0) {
    return security && Array.isArray(security) && security.length === 0
      ? [{ type: 'none', confidence: 0.9, evidence: 'OpenAPI security explicitly disabled for this operation.' }]
      : [];
  }

  const schemes = ((rootSpec.components as Record<string, unknown> | undefined)?.securitySchemes ??
    {}) as Record<string, Record<string, unknown>>;
  const hints: AuthHint[] = [];

  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object') {
      continue;
    }

    for (const schemeName of Object.keys(requirement as Record<string, unknown>)) {
      const scheme = schemes[schemeName];
      const type = String(scheme?.type ?? '').toLowerCase();
      const schemeNameValue = String(scheme?.scheme ?? '').toLowerCase();

      if (type === 'apikey') {
        hints.push({
          type: 'apiKey',
          headerName: typeof scheme?.name === 'string' && String(scheme?.in ?? '').toLowerCase() === 'header'
            ? String(scheme.name)
            : undefined,
          queryParamName: typeof scheme?.name === 'string' && String(scheme?.in ?? '').toLowerCase() === 'query'
            ? String(scheme.name)
            : undefined,
          cookieName: typeof scheme?.name === 'string' && String(scheme?.in ?? '').toLowerCase() === 'cookie'
            ? String(scheme.name)
            : undefined,
          confidence: 0.95,
          evidence: `OpenAPI security scheme "${schemeName}" defines apiKey auth.`
        });
        continue;
      }

      if (type === 'oauth2' || type === 'openidconnect') {
        hints.push({
          type: 'oauth2',
          headerName: 'Authorization',
          setupSteps: ['Provide API_TOKEN for OAuth-protected endpoints.'],
          confidence: 0.95,
          evidence: `OpenAPI security scheme "${schemeName}" defines OAuth/OpenID auth.`
        });
        continue;
      }

      if (type === 'http' && schemeNameValue === 'bearer') {
        hints.push({
          type: 'bearer',
          headerName: 'Authorization',
          setupSteps: ['Provide API_TOKEN for bearer-token endpoints.'],
          confidence: 0.95,
          evidence: `OpenAPI security scheme "${schemeName}" defines bearer auth.`
        });
      }
    }
  }

  return hints;
};

const resolveAuth = (
  rootSpec: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>
): ApiEndpoint['auth'] => {
  if (Array.isArray(operation.security)) {
    return inferAuthFromSecurity(operation.security, rootSpec);
  }

  if (Array.isArray(pathItem.security)) {
    return inferAuthFromSecurity(pathItem.security, rootSpec);
  }

  if (Array.isArray(rootSpec.security)) {
    return inferAuthFromSecurity(rootSpec.security, rootSpec);
  }

  return 'unknown';
};

/**
 * Resolves a JSON Pointer `$ref` (local only, e.g. `#/components/schemas/Pet`)
 * against the root spec. Returns the referenced object or undefined if not found.
 */
const resolveRef = (ref: string, rootSpec: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  const parts = ref.slice(2).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = rootSpec;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : undefined;
};

const parseSchema = (schema: unknown, rootSpec?: Record<string, unknown>): SchemaObject | undefined => {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  const source = schema as Record<string, unknown>;

  // Resolve $ref if present and rootSpec is provided
  if (typeof source.$ref === 'string' && rootSpec) {
    const resolved = resolveRef(source.$ref, rootSpec);
    if (resolved) {
      return parseSchema(resolved, rootSpec);
    }
    return undefined;
  }

  const parsed: SchemaObject = {
    type: String(source.type ?? 'object'),
    description: source.description ? String(source.description) : undefined,
    example: source.example
  };

  if (Array.isArray(source.required)) {
    parsed.required = source.required.map(String);
  }

  if (source.properties && typeof source.properties === 'object') {
    parsed.properties = {};
    for (const [key, value] of Object.entries(source.properties as Record<string, unknown>)) {
      parsed.properties[key] = parseSchema(value, rootSpec) ?? normalizeSchemaField(key, value as Record<string, unknown>);
    }
  }

  if (source.items && typeof source.items === 'object') {
    parsed.items = parseSchema(source.items, rootSpec);
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

    const rootSpec = parseDocument(file.content, file.path);
    if (!rootSpec?.paths || typeof rootSpec.paths !== 'object') {
      continue;
    }

    const paths = rootSpec.paths as Record<string, Record<string, unknown>>;

    for (const [pathKey, pathItemValue] of Object.entries(paths)) {
      if (!pathItemValue || typeof pathItemValue !== 'object') {
        continue;
      }

      const pathItem = pathItemValue as Record<string, unknown>;
      const pathLevelParameters = toParameterList(pathItem.parameters);

      for (const [methodKey, operationValue] of Object.entries(pathItem)) {
        const method = methodKey.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
          continue;
        }
        if (!operationValue || typeof operationValue !== 'object') {
          continue;
        }

        const operation = operationValue as Record<string, unknown>;

        // Resolve operation-level $ref if present
        const resolvedOp = typeof operation.$ref === 'string'
          ? (resolveRef(operation.$ref, rootSpec) ?? operation)
          : operation;
        const authHints = inferAuthHintsFromSecurity(
          Array.isArray(resolvedOp.security)
            ? resolvedOp.security
            : Array.isArray(pathItem.security)
              ? pathItem.security
              : rootSpec.security,
          rootSpec
        );

        const parameters = mergeParameters(pathLevelParameters, toParameterList(resolvedOp.parameters));

        const pathParams = parameters
          .filter((item) => item.in === 'path')
          .map((item) => {
            const schema = resolveSchemaRef(item.schema, rootSpec) ?? {};
            return normalizeSchemaField(String(item.name ?? 'param'), (schema ?? {}) as Record<string, unknown>, Boolean(item.required));
          });

        const queryParams = parameters
          .filter((item) => item.in === 'query')
          .map((item) => {
            const schema = resolveSchemaRef(item.schema, rootSpec) ?? {};
            return normalizeSchemaField(String(item.name ?? 'query'), (schema ?? {}) as Record<string, unknown>, Boolean(item.required));
          });

        const requestBody = resolveSchemaRef(resolvedOp.requestBody, rootSpec) ?? (resolvedOp.requestBody as Record<string, unknown> | undefined);
        const jsonBodySchema = requestBody?.content && typeof requestBody.content === 'object'
          ? ((requestBody.content as Record<string, Record<string, unknown>>)['application/json']?.schema as Record<string, unknown> | undefined)
          : undefined;

        // Resolve $ref in request body schema
        const resolvedBodySchema = jsonBodySchema && typeof jsonBodySchema.$ref === 'string'
          ? (resolveRef(jsonBodySchema.$ref, rootSpec) ?? jsonBodySchema)
          : jsonBodySchema;

        const responsesRaw = resolvedOp.responses as Record<string, Record<string, unknown>> | undefined;
        const responses: ApiEndpoint['responses'] = responsesRaw
          ? Object.entries(responsesRaw).map(([status, detail]) => ({
              status,
              description: detail.description ? String(detail.description) : undefined,
              contentType: detail.content && typeof detail.content === 'object'
                ? Object.keys(detail.content as Record<string, unknown>)[0]
                : undefined,
              schema: detail.content && typeof detail.content === 'object'
                ? parseSchema(
                    ((detail.content as Record<string, Record<string, unknown>>)['application/json']?.schema ??
                      Object.values(detail.content as Record<string, Record<string, unknown>>)[0]?.schema) as Record<string, unknown> | undefined,
                    rootSpec
                  )
                : undefined
            }))
          : [{ status: '200' }];
        const examples = [
          resolvedBodySchema
            ? {
                origin: 'openapi' as const,
                request: {
                  body: (resolvedBodySchema as Record<string, unknown>).example
                },
                note: 'Request example inferred from OpenAPI schema.'
              }
            : null,
          responses.find((response) => response.schema?.example)
            ? {
                origin: 'openapi' as const,
                response: {
                  status: Number(responses.find((response) => response.schema?.example)?.status ?? 200),
                  bodySnippet: JSON.stringify(responses.find((response) => response.schema?.example)?.schema?.example).slice(0, 180)
                },
                note: 'Response example inferred from OpenAPI schema.'
              }
            : null
        ].filter((value): value is NonNullable<typeof value> => Boolean(value));

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
            auth: resolveAuth(rootSpec, pathItem, resolvedOp),
            authHints,
            pathParams,
            queryParams,
            body: parseSchema(resolvedBodySchema, rootSpec),
            responses,
            examples,
            tags: Array.isArray(resolvedOp.tags) ? resolvedOp.tags.map(String) : undefined
          })
        );
      }
    }
  }

  return endpoints;
};
