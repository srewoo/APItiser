import { buildExamplePath, defaultExpectedStatus } from '@background/llm/endpointUtils';
import type {
  ApiEndpoint,
  BatchQualityAssessment,
  GeneratedTestCase,
  QualityIssue
} from '@shared/types';

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeHeaders = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, string>>((acc, [key, headerValue]) => {
    if (headerValue !== undefined && headerValue !== null) {
      acc[key] = String(headerValue);
    }
    return acc;
  }, {});
};

const normalizeQuery = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const getAuthPlaceholderValue = (hintType?: ApiEndpoint['auth']): string =>
  hintType === 'apiKey' ? '{{API_KEY}}' : hintType === 'csrf' ? '{{CSRF_TOKEN}}' : 'Bearer {{API_TOKEN}}';

export const defaultAuthHeadersForEndpoint = (endpoint: ApiEndpoint): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const hint of endpoint.authHints ?? []) {
    if (hint.headerName) {
      headers[hint.headerName] = getAuthPlaceholderValue(hint.type);
    }
  }
  if (!Object.keys(headers).length && (endpoint.auth === 'bearer' || endpoint.auth === 'oauth2')) {
    headers.Authorization = 'Bearer {{API_TOKEN}}';
  }
  return headers;
};

const defaultResponseForStatus = (endpoint: ApiEndpoint, status: number) =>
  endpoint.responses.find((response) => Number(response.status) === status)
  ?? endpoint.responses.find((response) => Number(response.status) >= 200 && Number(response.status) < 300);

const defaultContractChecks = (endpoint: ApiEndpoint, category: GeneratedTestCase['category']): string[] => {
  const checks: string[] = [];
  if (endpoint.responses.some((response) => Boolean(response.schema))) {
    checks.push('response matches documented schema');
  }
  if (endpoint.queryParams.some((param) => /page|limit|offset|cursor/i.test(param.name))) {
    checks.push('pagination semantics preserved');
  }
  if (category === 'security') {
    checks.push('auth boundary enforced');
  }
  if (['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method)) {
    checks.push('request remains idempotent');
  }
  return checks;
};

const isLikelyPaginatedEndpoint = (endpoint: ApiEndpoint): boolean =>
  endpoint.queryParams.some((param) => /page|limit|offset|cursor/i.test(param.name))
  || /(page|limit|offset|cursor|search|list|collection)/i.test(endpoint.path);

const inferredTrustLabel = (score: number): GeneratedTestCase['trustLabel'] =>
  score >= 82 ? 'high' : score >= 62 ? 'medium' : 'heuristic';

export const endpointPathToRegex = (path: string): RegExp => {
  // Replace param tokens before escaping so the replacement text isn't mangled
  const substituted = path
    .replace(/:\w+\*/g, '\x00WILD\x00')
    .replace(/\{[^}]+\}/g, '\x00PARAM\x00')
    .replace(/:\w+/g, '\x00PARAM\x00');
  const escaped = substituted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const final = escaped
    .replace(/\x00WILD\x00/g, '.+')
    .replace(/\x00PARAM\x00/g, '[^/]+');
  return new RegExp(`^${final}$`, 'i');
};

export const hasPlaceholders = (path: string): boolean => /:\w|\{[^}]+\}/.test(path);

const normalizeRequestPath = (value: unknown, endpoint: ApiEndpoint): string => {
  const candidate = typeof value === 'string' ? value.trim().split('?')[0] : '';
  if (candidate && !hasPlaceholders(candidate) && endpointPathToRegex(endpoint.path).test(candidate)) {
    return candidate;
  }
  return buildExamplePath(endpoint);
};

export const isCategoryApplicable = (endpoint: ApiEndpoint, category: GeneratedTestCase['category']): boolean => {
  if (category !== 'security') {
    return true;
  }
  return endpoint.auth !== 'none' || endpoint.method !== 'GET';
};

const endpointNeedsConcretePathValues = (endpoint: ApiEndpoint): boolean => hasPlaceholders(endpoint.path);

// ---------------------------------------------------------------------------
// Quality issue creation
// ---------------------------------------------------------------------------

export const createIssue = (
  code: QualityIssue['code'],
  severity: QualityIssue['severity'],
  message: string,
  endpointId?: string,
  category?: QualityIssue['category']
): QualityIssue => ({ code, severity, message, endpointId, category });

// ---------------------------------------------------------------------------
// Per-test quality predicates
// ---------------------------------------------------------------------------

const statusAllowedForEndpoint = (endpoint: ApiEndpoint, test: GeneratedTestCase): boolean => {
  const status = test.expected.status;
  const documented = endpoint.responses
    .map((response) => Number(response.status))
    .filter((value) => Number.isFinite(value));

  if (test.category === 'negative' || test.category === 'security') {
    return status >= 400 || documented.includes(status);
  }
  if (test.category === 'edge') {
    return documented.includes(status) || status === defaultExpectedStatus(endpoint) || [400, 404, 409, 413, 422, 429].includes(status);
  }
  if (documented.length === 0) {
    return status === defaultExpectedStatus(endpoint);
  }
  return documented.includes(status) || status === defaultExpectedStatus(endpoint);
};

export const titleIsGeneric = (title: string, endpoint: ApiEndpoint): boolean => {
  const normalized = title.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (['generated test', 'api test', 'test case', 'endpoint test', 'request test'].some((value) => normalized.includes(value))) {
    return true;
  }
  const normalizedPath = endpoint.path.toLowerCase().replace(/[:{}]/g, '');
  return normalized.length < 10 || normalized === `${endpoint.method.toLowerCase()} ${normalizedPath}`;
};

const securityTestLooksWeak = (endpoint: ApiEndpoint, test: GeneratedTestCase): boolean => {
  if (test.category !== 'security') {
    return false;
  }
  const normalizedTitle = test.title.toLowerCase();
  const authHeader = test.request.headers?.Authorization ?? test.request.headers?.authorization;
  const hasAuthFailureStatus = [400, 401, 403, 404, 422, 429].includes(test.expected.status);
  const mentionsSecurityBehavior = ['unauthorized', 'forbidden', 'idor', 'rate', 'privilege', 'auth', 'token', 'injection', 'mass assignment']
    .some((token) => normalizedTitle.includes(token));

  if (endpoint.auth === 'bearer') {
    return !hasAuthFailureStatus && authHeader === 'Bearer {{API_TOKEN}}' && !mentionsSecurityBehavior;
  }
  return !hasAuthFailureStatus && !mentionsSecurityBehavior;
};

// ---------------------------------------------------------------------------
// Repair guard helpers
// ---------------------------------------------------------------------------

const repairTestKey = (test: GeneratedTestCase): string => `${test.endpointId}::${test.category}`;

export const assertionStrength = (test: GeneratedTestCase): number =>
  (test.expected.contains?.length ?? 0)
  + (test.expected.contentType ? 2 : 0)
  + Object.keys(test.expected.responseHeaders ?? {}).length
  + (test.expected.jsonSchema ? 3 : 0)
  + (test.expected.contractChecks?.length ?? 0)
  + (test.expected.pagination ? 1 : 0)
  + (test.expected.idempotent ? 1 : 0);

const requestHasAuthMaterial = (test: GeneratedTestCase): boolean => {
  const headers = test.request.headers ?? {};
  return Object.keys(headers).some((headerName) => /authorization|api[-_]key|cookie|csrf/i.test(headerName));
};

const allowRepairToChangeStatus = (issues: QualityIssue[]): boolean =>
  issues.some((issue) => ['invalid-status', 'execution-status', 'execution-auth'].includes(issue.code));

const isSafeRepairReplacement = (
  endpoint: ApiEndpoint,
  previous: GeneratedTestCase,
  candidate: GeneratedTestCase,
  issues: QualityIssue[]
): boolean => {
  if (candidate.endpointId !== previous.endpointId || candidate.category !== previous.category) {
    return false;
  }
  if (candidate.request.method !== previous.request.method) {
    return false;
  }
  if (!endpointPathToRegex(endpoint.path).test(candidate.request.path) || hasPlaceholders(candidate.request.path)) {
    return false;
  }
  if (!allowRepairToChangeStatus(issues) && candidate.expected.status !== previous.expected.status) {
    return false;
  }
  if (previous.expected.contentType && !candidate.expected.contentType) {
    return false;
  }
  if (previous.expected.jsonSchema && !candidate.expected.jsonSchema) {
    return false;
  }
  if ((previous.expected.contractChecks?.length ?? 0) > (candidate.expected.contractChecks?.length ?? 0)) {
    return false;
  }
  if (Object.keys(previous.expected.responseHeaders ?? {}).length > Object.keys(candidate.expected.responseHeaders ?? {}).length) {
    return false;
  }
  if (requestHasAuthMaterial(previous) && !requestHasAuthMaterial(candidate) && previous.category !== 'security') {
    return false;
  }
  if (assertionStrength(candidate) < assertionStrength(previous)) {
    return false;
  }
  if (!titleIsGeneric(previous.title, endpoint) && titleIsGeneric(candidate.title, endpoint)) {
    return false;
  }
  return true;
};

export const mergeSafeRepairs = (
  previousTests: GeneratedTestCase[],
  repairedTests: GeneratedTestCase[],
  endpoints: ApiEndpoint[],
  issues: QualityIssue[]
): GeneratedTestCase[] => {
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const issuesByEndpoint = new Map<string, QualityIssue[]>();
  for (const issue of issues) {
    if (!issue.endpointId) {
      continue;
    }
    const existing = issuesByEndpoint.get(issue.endpointId) ?? [];
    existing.push(issue);
    issuesByEndpoint.set(issue.endpointId, existing);
  }

  const merged = new Map<string, GeneratedTestCase>();
  const previousByKey = new Map(previousTests.map((test) => [repairTestKey(test), test]));
  const repairedByKey = new Map(repairedTests.map((test) => [repairTestKey(test), test]));

  for (const [key, previous] of previousByKey.entries()) {
    const endpoint = endpointById.get(previous.endpointId);
    const candidate = repairedByKey.get(key);
    if (endpoint && candidate && isSafeRepairReplacement(endpoint, previous, candidate, issuesByEndpoint.get(previous.endpointId) ?? [])) {
      merged.set(key, candidate);
    } else {
      merged.set(key, previous);
    }
  }

  for (const [key, candidate] of repairedByKey.entries()) {
    if (!merged.has(key)) {
      merged.set(key, candidate);
    }
  }

  return [...merged.values()];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const assessGeneratedTestQuality = (
  endpoints: ApiEndpoint[],
  tests: GeneratedTestCase[],
  requiredCategories: string[]
): BatchQualityAssessment => {
  const testsByEndpoint = new Map<string, GeneratedTestCase[]>();
  const issues: QualityIssue[] = [];

  for (const test of tests) {
    const existing = testsByEndpoint.get(test.endpointId) ?? [];
    existing.push(test);
    testsByEndpoint.set(test.endpointId, existing);
  }

  for (const endpoint of endpoints) {
    const endpointTests = testsByEndpoint.get(endpoint.id) ?? [];
    if (endpointTests.length === 0) {
      issues.push(createIssue('missing-endpoint-tests', 'error', `Missing all tests for ${endpoint.method} ${endpoint.path}`, endpoint.id));
      continue;
    }

    for (const category of requiredCategories) {
      if (!isCategoryApplicable(endpoint, category as GeneratedTestCase['category'])) {
        continue;
      }
      if (!endpointTests.some((test) => test.category === category)) {
        issues.push(createIssue('missing-category', 'error', `Missing ${category} test for ${endpoint.method} ${endpoint.path}`, endpoint.id, category as QualityIssue['category']));
      }
    }

    if (
      endpointNeedsConcretePathValues(endpoint)
      && !endpointTests.some((test) => test.request.path !== endpoint.path && !hasPlaceholders(test.request.path))
    ) {
      issues.push(createIssue('unresolved-path', 'error', `No concrete path values generated for ${endpoint.method} ${endpoint.path}`, endpoint.id));
    }

    for (const test of endpointTests) {
      if (!statusAllowedForEndpoint(endpoint, test)) {
        issues.push(createIssue('invalid-status', 'error', `Unexpected status ${test.expected.status} for ${endpoint.method} ${endpoint.path}`, endpoint.id, test.category));
      }
      if (titleIsGeneric(test.title, endpoint)) {
        issues.push(createIssue('generic-title', 'error', `Generic title for ${endpoint.method} ${endpoint.path}: "${test.title}"`, endpoint.id, test.category));
      }
      if (securityTestLooksWeak(endpoint, test)) {
        issues.push(createIssue('weak-security', 'error', `Weak security behavior for ${endpoint.method} ${endpoint.path}`, endpoint.id, test.category));
      }
      const documentedResponse = defaultResponseForStatus(endpoint, test.expected.status);
      if (test.category === 'positive' && documentedResponse?.schema && !test.expected.jsonSchema) {
        issues.push(createIssue('schema-assertion', 'error', `Missing schema assertion for ${endpoint.method} ${endpoint.path}`, endpoint.id, test.category));
      }
      if (!test.expected.contractChecks?.length) {
        issues.push(createIssue('contract-assertion', 'warn', `Missing contract assertions for ${endpoint.method} ${endpoint.path}`, endpoint.id, test.category));
      }
    }
  }

  return { passed: !issues.some((issue) => issue.severity === 'error'), issues };
};

export const normalizeGeneratedTests = (
  input: unknown,
  allowedCategories: string[],
  endpoints: ApiEndpoint[]
): GeneratedTestCase[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const endpointsById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const seen = new Set<string>();

  return input.reduce<GeneratedTestCase[]>((acc, item) => {
    if (!item || typeof item !== 'object') {
      return acc;
    }

    const source = item as Record<string, unknown>;
    const endpoint = endpointsById.get(String(source.endpointId ?? ''));
    if (!endpoint) {
      return acc;
    }
    const category = String(source.category ?? 'positive');
    const request = (source.request as Record<string, unknown> | undefined) ?? {};
    const expected = (source.expected as Record<string, unknown> | undefined) ?? {};
    const headers = normalizeHeaders(request.headers);
    const defaultHeaders = defaultAuthHeadersForEndpoint(endpoint);

    for (const [headerName, headerValue] of Object.entries(defaultHeaders)) {
      if (!(headerName in headers) && !(headerName.toLowerCase() in headers)) {
        headers[headerName] = headerValue;
      }
    }

    const status = Number.isFinite(Number(expected.status)) ? Number(expected.status) : defaultExpectedStatus(endpoint);
    const documentedResponse = defaultResponseForStatus(endpoint, status);
    const trustScore = Math.max(1, Math.min(99, Math.round((endpoint.trustScore ?? Math.round((endpoint.confidence ?? 0.5) * 100)) - (String(source.title ?? '').toLowerCase().includes('generated') ? 12 : 0))));

    const normalized: GeneratedTestCase = {
      endpointId: endpoint.id,
      category: allowedCategories.includes(category) ? (category as GeneratedTestCase['category']) : 'positive',
      title: String(source.title ?? `${endpoint.method} ${endpoint.path} generated test`),
      rationale: typeof source.rationale === 'string' ? source.rationale : endpoint.summary ?? endpoint.description,
      trustScore,
      trustLabel: inferredTrustLabel(trustScore),
      request: {
        method: endpoint.method,
        path: normalizeRequestPath(request.path, endpoint),
        headers,
        query: normalizeQuery(request.query),
        body: request.body
      },
      expected: {
        status,
        contains: Array.isArray(expected.contains)
          ? (expected.contains as string[]).map((value) => String(value)).filter(Boolean)
          : [],
        contentType: typeof expected.contentType === 'string' ? expected.contentType : documentedResponse?.contentType,
        responseHeaders: normalizeHeaders(expected.responseHeaders),
        jsonSchema: isRecord(expected.jsonSchema)
          ? (expected.jsonSchema as unknown as GeneratedTestCase['expected']['jsonSchema'])
          : (category === 'positive' ? documentedResponse?.schema : undefined),
        contractChecks: Array.isArray(expected.contractChecks)
          ? expected.contractChecks.map((value) => String(value))
          : defaultContractChecks(endpoint, allowedCategories.includes(category) ? (category as GeneratedTestCase['category']) : 'positive'),
        pagination: typeof expected.pagination === 'boolean' ? expected.pagination : isLikelyPaginatedEndpoint(endpoint),
        idempotent: typeof expected.idempotent === 'boolean' ? expected.idempotent : ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method)
      }
    };

    const key = [
      normalized.endpointId,
      normalized.category,
      normalized.title,
      normalized.request.method,
      normalized.request.path,
      normalized.expected.status
    ].join('|');

    if (!seen.has(key)) {
      seen.add(key);
      acc.push(normalized);
    }
    return acc;
  }, []);
};
