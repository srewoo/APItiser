import type {
  ApiEndpoint,
  AuthHint,
  AuthType,
  EndpointExample,
  EndpointResponse,
  RepoFile,
  SchemaField,
  SchemaObject,
  TrustLabel
} from '@shared/types';

const defaultTestFilePattern = /(?:\.test|\.spec)\.(?:[jt]sx?|mjs|cjs|py)$/i;

const normalizeDir = (value: string): string => value.trim().replace(/^\/+|\/+$/g, '');

const isLikelyTestFile = (path: string): boolean => {
  const normalizedPath = path.replace(/^\/+/, '');
  const segments = normalizedPath.split('/');
  if (defaultTestFilePattern.test(path)) {
    return true;
  }
  return ['tests', '__tests__', 'test'].some((dir) => segments.includes(normalizeDir(dir)));
};

const mergeSchemaField = (left: SchemaField, right: SchemaField): SchemaField => ({
  ...left,
  ...right,
  description: right.description ?? left.description,
  format: right.format ?? left.format,
  example: right.example ?? left.example,
  required: left.required || right.required
});

const isSchemaField = (value: SchemaObject | SchemaField): value is SchemaField => 'name' in value;

const mergeSchema = (left?: SchemaObject, right?: SchemaObject): SchemaObject | undefined => {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const properties: Record<string, SchemaObject | SchemaField> = {};
  for (const key of new Set([...Object.keys(left.properties ?? {}), ...Object.keys(right.properties ?? {})])) {
    const leftProp = left.properties?.[key];
    const rightProp = right.properties?.[key];

    if (!leftProp) {
      properties[key] = rightProp!;
      continue;
    }
    if (!rightProp) {
      properties[key] = leftProp;
      continue;
    }

    properties[key] = isSchemaField(leftProp) && isSchemaField(rightProp)
      ? mergeSchemaField(leftProp, rightProp)
      : mergeSchema(isSchemaField(leftProp) ? { type: leftProp.type, description: leftProp.description, example: leftProp.example } : leftProp, isSchemaField(rightProp) ? { type: rightProp.type, description: rightProp.description, example: rightProp.example } : rightProp)!;
  }

  return {
    ...left,
    ...right,
    description: right.description ?? left.description,
    example: right.example ?? left.example,
    required: [...new Set([...(left.required ?? []), ...(right.required ?? [])])],
    items: mergeSchema(left.items, right.items),
    properties
  };
};

const mergeFields = (left: SchemaField[], right: SchemaField[]): SchemaField[] => {
  const merged = new Map<string, SchemaField>();
  for (const field of [...left, ...right]) {
    const existing = merged.get(field.name);
    merged.set(field.name, existing ? mergeSchemaField(existing, field) : field);
  }
  return [...merged.values()];
};

const mergeResponses = (left: EndpointResponse[], right: EndpointResponse[]): EndpointResponse[] => {
  const merged = new Map<string, EndpointResponse>();
  for (const response of [...left, ...right]) {
    const existing = merged.get(response.status);
    merged.set(response.status, existing
      ? {
          ...existing,
          ...response,
          description: response.description ?? existing.description,
          contentType: response.contentType ?? existing.contentType,
          schema: mergeSchema(existing.schema, response.schema)
        }
      : response);
  }
  return [...merged.values()].sort((a, b) => Number(a.status) - Number(b.status));
};

const authSpecificity = (value?: AuthType): number => {
  switch (value) {
    case 'oauth2':
      return 6;
    case 'bearer':
      return 5;
    case 'apiKey':
      return 4;
    case 'cookieSession':
      return 3;
    case 'csrf':
      return 2;
    case 'none':
      return 1;
    default:
      return 0;
  }
};

const chooseAuth = (left?: AuthType, right?: AuthType): AuthType | undefined =>
  authSpecificity(right) >= authSpecificity(left) ? right : left;

const mergeAuthHints = (left: AuthHint[] = [], right: AuthHint[] = []): AuthHint[] => {
  const merged = new Map<string, AuthHint>();
  for (const hint of [...left, ...right]) {
    const key = `${hint.type}:${hint.headerName ?? ''}:${hint.cookieName ?? ''}:${hint.csrfHeaderName ?? ''}:${hint.queryParamName ?? ''}`;
    const existing = merged.get(key);
    merged.set(key, existing
      ? {
          ...existing,
          ...hint,
          confidence: Math.max(existing.confidence ?? 0, hint.confidence ?? 0),
          setupSteps: [...new Set([...(existing.setupSteps ?? []), ...(hint.setupSteps ?? [])])]
        }
      : hint);
  }
  return [...merged.values()];
};

const mergeExamples = (left: EndpointExample[] = [], right: EndpointExample[] = []): EndpointExample[] => {
  const seen = new Set<string>();
  const merged: EndpointExample[] = [];
  for (const example of [...left, ...right]) {
    const key = JSON.stringify(example);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(example);
    }
  }
  return merged.slice(0, 5);
};

const endpointStaticSegments = (path: string): string[] =>
  path
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .filter((segment) => !segment.startsWith(':') && !/^\{[^}]+\}$/.test(segment));

const matchesEndpointInTest = (contentLower: string, endpoint: ApiEndpoint): boolean => {
  const method = endpoint.method.toLowerCase();
  if (!contentLower.includes(method)) {
    return false;
  }
  const segments = endpointStaticSegments(endpoint.path).filter((segment) => segment.length >= 3);
  return segments.length === 0 ? false : segments.every((segment) => contentLower.includes(segment));
};

const inferHintsFromTestFile = (file: RepoFile): { authHints: AuthHint[]; example?: EndpointExample } => {
  const content = file.content;
  const lower = content.toLowerCase();
  const authHints: AuthHint[] = [];
  const headers: Record<string, string> = {};

  if (/authorization|bearer|jwt|passport/i.test(content)) {
    authHints.push({
      type: /oauth/i.test(content) ? 'oauth2' : 'bearer',
      headerName: 'Authorization',
      setupSteps: ['Provide API_TOKEN in the execution environment.'],
      confidence: 0.82,
      evidence: 'Existing tests mention Authorization/Bearer handling.'
    });
    headers.Authorization = 'Bearer {{API_TOKEN}}';
  }

  const apiKeyHeaderMatch = content.match(/\b(X-[A-Za-z-]*API[-_]KEY|X-API-KEY|api-key)\b/i);
  if (apiKeyHeaderMatch) {
    authHints.push({
      type: 'apiKey',
      headerName: apiKeyHeaderMatch[1],
      setupSteps: ['Provide API_KEY in the execution environment.'],
      confidence: 0.8,
      evidence: 'Existing tests mention API key headers.'
    });
    headers[apiKeyHeaderMatch[1]] = '{{API_KEY}}';
  }

  if (/cookie|set-cookie|req\.session|session/i.test(content)) {
    authHints.push({
      type: 'cookieSession',
      cookieName: 'session',
      setupSteps: ['Provide SESSION_COOKIE if the API requires an authenticated browser/session cookie.'],
      confidence: 0.78,
      evidence: 'Existing tests mention cookies or session state.'
    });
  }

  if (/csrf|xsrf/i.test(content)) {
    authHints.push({
      type: 'csrf',
      csrfHeaderName: 'X-CSRF-Token',
      setupSteps: ['Provide CSRF_TOKEN when validating mutating endpoints.'],
      confidence: 0.75,
      evidence: 'Existing tests mention CSRF/XSRF protection.'
    });
    headers['X-CSRF-Token'] = '{{CSRF_TOKEN}}';
  }

  if (!authHints.length) {
    return { authHints: [] };
  }

  return {
    authHints,
    example: {
      origin: 'existing-test',
      request: {
        headers: Object.keys(headers).length ? headers : undefined
      },
      note: lower.includes('expect(401') || lower.includes('status_code == 401')
        ? 'Existing tests appear to exercise auth failures.'
        : 'Existing tests reference auth/session behavior.'
    }
  };
};

const applyExistingTestSignals = (endpoint: ApiEndpoint, files: RepoFile[]): ApiEndpoint => {
  const matchingFiles = files.filter((file) => isLikelyTestFile(file.path) && matchesEndpointInTest(file.content.toLowerCase(), endpoint));
  if (!matchingFiles.length) {
    return endpoint;
  }

  const inferredHints: AuthHint[] = [];
  const inferredExamples: EndpointExample[] = [];
  for (const file of matchingFiles.slice(0, 3)) {
    const inferred = inferHintsFromTestFile(file);
    if (inferred.authHints) {
      inferredHints.push(...inferred.authHints);
    }
    if (inferred.example) {
      inferredExamples.push(inferred.example);
    }
  }

  return {
    ...endpoint,
    auth: chooseAuth(endpoint.auth, inferredHints[0]?.type),
    authHints: mergeAuthHints(endpoint.authHints, inferredHints),
    examples: mergeExamples(endpoint.examples, inferredExamples),
    sourceMetadata: {
      sources: endpoint.sourceMetadata?.sources ?? [endpoint.source],
      hasExistingTests: true,
      mergedFromOpenApi: endpoint.sourceMetadata?.mergedFromOpenApi ?? endpoint.source === 'openapi',
      mergedFromCode: endpoint.sourceMetadata?.mergedFromCode ?? endpoint.source !== 'openapi',
      inferredFromExamples: inferredHints.length > 0
    }
  };
};

const computeTrustScore = (endpoint: ApiEndpoint): { trustScore: number; trustLabel: TrustLabel } => {
  let score = Math.round((endpoint.confidence ?? 0.4) * 100);
  const sourceCount = endpoint.sourceMetadata?.sources.length ?? 1;
  if (endpoint.sourceMetadata?.mergedFromOpenApi && endpoint.sourceMetadata?.mergedFromCode) {
    score += 18;
  } else if (sourceCount > 1) {
    score += 10;
  }
  if (endpoint.responses.some((response) => response.schema)) {
    score += 12;
  }
  if (endpoint.body?.properties && Object.keys(endpoint.body.properties).length > 0) {
    score += 8;
  }
  if ((endpoint.examples?.length ?? 0) > 0) {
    score += 7;
  }
  if ((endpoint.authHints?.length ?? 0) > 0 || (endpoint.auth && endpoint.auth !== 'unknown')) {
    score += 7;
  }
  if (endpoint.sourceMetadata?.hasExistingTests) {
    score += 5;
  }

  const trustScore = Math.max(1, Math.min(score, 99));
  const trustLabel: TrustLabel = trustScore >= 82 ? 'high' : trustScore >= 62 ? 'medium' : 'heuristic';
  return { trustScore, trustLabel };
};

const mergeEndpoint = (left: ApiEndpoint, right: ApiEndpoint): ApiEndpoint => {
  const merged: ApiEndpoint = {
    ...left,
    ...right,
    source: left.source === 'openapi' || right.source !== 'openapi' ? left.source : right.source,
    filePath: right.filePath ?? left.filePath,
    operationId: right.operationId ?? left.operationId,
    summary: right.summary ?? left.summary,
    description: right.description ?? left.description,
    auth: chooseAuth(left.auth, right.auth),
    confidence: Math.max(left.confidence ?? 0, right.confidence ?? 0),
    evidence: [...new Map([...(left.evidence ?? []), ...(right.evidence ?? [])].map((item) => [`${item.filePath}:${item.line ?? 0}:${item.reason}`, item])).values()],
    pathParams: mergeFields(left.pathParams, right.pathParams),
    queryParams: mergeFields(left.queryParams, right.queryParams),
    body: mergeSchema(left.body, right.body),
    responses: mergeResponses(left.responses, right.responses),
    authHints: mergeAuthHints(left.authHints, right.authHints),
    examples: mergeExamples(left.examples, right.examples),
    sourceMetadata: {
      sources: [...new Set([...(left.sourceMetadata?.sources ?? [left.source]), ...(right.sourceMetadata?.sources ?? [right.source])])],
      hasExistingTests: (left.sourceMetadata?.hasExistingTests ?? false) || (right.sourceMetadata?.hasExistingTests ?? false),
      mergedFromOpenApi: (left.sourceMetadata?.mergedFromOpenApi ?? left.source === 'openapi') || (right.sourceMetadata?.mergedFromOpenApi ?? right.source === 'openapi'),
      mergedFromCode: (left.sourceMetadata?.mergedFromCode ?? left.source !== 'openapi') || (right.sourceMetadata?.mergedFromCode ?? right.source !== 'openapi'),
      inferredFromExamples: (left.sourceMetadata?.inferredFromExamples ?? false) || (right.sourceMetadata?.inferredFromExamples ?? false)
    }
  };

  const trust = computeTrustScore(merged);
  return {
    ...merged,
    ...trust
  };
};

export const canonicalizeEndpoints = (endpoints: ApiEndpoint[], files: RepoFile[]): ApiEndpoint[] => {
  const deduped = new Map<string, ApiEndpoint>();

  for (const endpoint of endpoints) {
    const key = `${endpoint.method}:${endpoint.path}`;
    const baseEndpoint: ApiEndpoint = {
      ...endpoint,
      sourceMetadata: endpoint.sourceMetadata ?? {
        sources: [endpoint.source],
        hasExistingTests: false,
        mergedFromOpenApi: endpoint.source === 'openapi',
        mergedFromCode: endpoint.source !== 'openapi',
        inferredFromExamples: false
      }
    };
    const current = deduped.get(key);
    deduped.set(key, current ? mergeEndpoint(current, baseEndpoint) : mergeEndpoint(baseEndpoint, baseEndpoint));
  }

  return [...deduped.values()]
    .map((endpoint) => applyExistingTestSignals(endpoint, files))
    .map((endpoint) => ({ ...endpoint, ...computeTrustScore(endpoint) }))
    .sort((a, b) => {
      if (a.path === b.path) {
        return a.method.localeCompare(b.method);
      }
      return a.path.localeCompare(b.path);
    });
};
