import type { ApiEndpoint, EndpointEvidence, RepoFile } from '@shared/types';

const toEndpointId = (method: string, path: string): string => `${method.toUpperCase()}::${path}`;

const normalizeSegment = (value: string): string => value.replace(/^\/+|\/+$/g, '');

export const normalizePath = (value: string): string => {
  const trimmed = value.trim();
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
    responses: params.responses ?? [{ status: '200' }, { status: '400' }, { status: '401' }]
  };
};
