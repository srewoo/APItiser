import type { ApiEndpoint, EndpointEvidence, RepoFile, SchemaField, SchemaObject } from '@shared/types';

const toEndpointId = (method: string, path: string): string => `${method.toUpperCase()}::${path}`;

const normalizeSegment = (value: string): string => value.replace(/^\/+|\/+$/g, '');

export const normalizePath = (value: string): string => {
  const trimmed = value.trim().replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
  if (!trimmed) {
    return '/';
  }
  if (trimmed === '*') {
    return '/*';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

export const joinPath = (prefix: string, child: string): string => {
  const left = normalizeSegment(prefix);
  const right = normalizeSegment(child);
  if (!left && !right) {
    return '/';
  }
  if (!left) {
    return normalizePath(right);
  }
  if (!right) {
    return normalizePath(left);
  }
  return normalizePath(`${left}/${right}`);
};

export const extractPathParams = (path: string) => {
  const params = new Set<string>();
  for (const match of path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    params.add(match[1]);
  }
  for (const match of path.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    params.add(match[1]);
  }
  return [...params].map((name) => ({
    name,
    required: true,
    type: 'string'
  }));
};

const SAMPLE_BY_TYPE: Record<string, unknown> = {
  string: 'example',
  integer: 1,
  number: 1,
  boolean: true,
  array: [],
  object: {}
};

/** Produce a deterministic sample value for a primitive type/format pair. */
export const sampleForType = (type?: string, format?: string): unknown => {
  if (format === 'email') {
    return 'user@example.com';
  }
  if (format === 'uuid') {
    return '00000000-0000-0000-0000-000000000000';
  }
  if (format === 'date-time') {
    return '2024-01-01T00:00:00Z';
  }
  if (format === 'date') {
    return '2024-01-01';
  }
  return SAMPLE_BY_TYPE[type ?? 'string'] ?? 'example';
};

const isSchemaField = (value: SchemaObject | SchemaField): value is SchemaField => 'name' in value;

/** Recursively build a concrete example object from a recovered SchemaObject. */
export const exampleFromSchema = (schema?: SchemaObject): unknown => {
  if (!schema) {
    return undefined;
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (schema.type === 'array') {
    const item = exampleFromSchema(schema.items);
    return item === undefined ? [] : [item];
  }
  if (schema.type !== 'object') {
    return sampleForType(schema.type);
  }
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (required.size > 0 && !required.has(key)) {
      continue;
    }
    result[key] = isSchemaField(value) ? sampleForType(value.type, value.format) : exampleFromSchema(value);
  }
  return result;
};

/** Build an object SchemaObject from a flat list of recovered fields. */
export const makeBodySchema = (
  fields: Array<{ name: string; type?: string; required?: boolean; format?: string }>
): SchemaObject | undefined => {
  if (!fields.length) {
    return undefined;
  }
  const properties: Record<string, SchemaField> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = {
      name: field.name,
      type: field.type ?? 'string',
      required: field.required ?? false,
      format: field.format
    };
    if (field.required) {
      required.push(field.name);
    }
  }
  return {
    type: 'object',
    properties,
    required: required.length ? required : undefined
  };
};

export const clampConfidence = (value: number): number => {
  if (Number.isNaN(value)) {
    return 0.5;
  }
  return Math.max(0.05, Math.min(0.99, Number(value.toFixed(2))));
};

export const lineFromIndex = (content: string, index: number): number => {
  if (index <= 0) {
    return 1;
  }
  return content.slice(0, index).split('\n').length;
};

export const snippetAtLine = (content: string, line: number): string | undefined => {
  const lines = content.split('\n');
  const candidate = lines[Math.max(line - 1, 0)];
  return candidate ? candidate.trim().slice(0, 180) : undefined;
};

export const makeEvidence = (file: RepoFile, reason: string, index?: number): EndpointEvidence => {
  const line = index === undefined ? undefined : lineFromIndex(file.content, index);
  return {
    filePath: file.path,
    line,
    snippet: line ? snippetAtLine(file.content, line) : undefined,
    reason
  };
};

export const buildEndpoint = (params: {
  method: string;
  path: string;
  source: ApiEndpoint['source'];
  file: RepoFile;
  auth?: ApiEndpoint['auth'];
  confidence: number;
  evidence: EndpointEvidence[];
  operationId?: string;
  summary?: string;
  description?: string;
  pathParams?: ApiEndpoint['pathParams'];
  queryParams?: ApiEndpoint['queryParams'];
  body?: ApiEndpoint['body'];
  responses?: ApiEndpoint['responses'];
  authHints?: ApiEndpoint['authHints'];
  examples?: ApiEndpoint['examples'];
  sourceMetadata?: ApiEndpoint['sourceMetadata'];
  tags?: ApiEndpoint['tags'];
}): ApiEndpoint => {
  const method = params.method.toUpperCase();
  const path = normalizePath(params.path);
  return {
    id: toEndpointId(method, path),
    method,
    path,
    source: params.source,
    filePath: params.file.path,
    operationId: params.operationId,
    summary: params.summary,
    description: params.description,
    auth: params.auth ?? 'unknown',
    confidence: clampConfidence(params.confidence),
    evidence: params.evidence,
    pathParams: params.pathParams ?? extractPathParams(path),
    queryParams: params.queryParams ?? [],
    body: params.body,
    responses: params.responses ?? [{ status: '200' }, { status: '400' }, { status: '401' }],
    authHints: params.authHints,
    examples: params.examples,
    sourceMetadata: params.sourceMetadata,
    tags: params.tags
  };
};
