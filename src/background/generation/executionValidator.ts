import { fetchWithTimeout } from '@background/llm/fetchWithTimeout';
import { statusSatisfied, statusExpectationLabel } from './statusExpectation';
import type {
  ApiEndpoint,
  BodyAssertion,
  ExtensionSettings,
  GeneratedTestCase,
  RequestIdentity,
  SchemaField,
  SchemaObject,
  ValidationFailure,
  ValidationResult,
  ValidationSetupStepResult,
  ValidationSummary
} from '@shared/types';

interface RuntimeExecutionState {
  apiToken: string;
  apiKey: string;
  csrfToken: string;
  sessionCookie: string;
  /** Arbitrary named values (e.g. USER_ID) used to resolve {{NAME}} placeholders. */
  values: Record<string, string>;
}

const snippet = (value: string): string => value.slice(0, 240);

const createRuntimeState = (settings: ExtensionSettings): RuntimeExecutionState => ({
  apiToken: settings.runtimeApiToken || '',
  apiKey: settings.runtimeApiKey || '',
  csrfToken: settings.runtimeCsrfToken || '',
  sessionCookie: settings.runtimeSessionCookie || '',
  values: { ...(settings.runtimeValues ?? {}) }
});

const RUNTIME_TOKEN_RE = /\{\{(\w+)\}\}/g;

/**
 * Resolve every {{NAME}} placeholder in a string. The four auth tokens use their
 * dedicated runtime slots; any other name resolves from the named-value registry
 * (configured `runtimeValues` or values captured by setup steps). Unknown names fall
 * back to 'replace-me' so a literal `{{...}}` never reaches the wire.
 */
const resolveTemplateValue = (value: string, runtimeState: RuntimeExecutionState): string =>
  value.replace(RUNTIME_TOKEN_RE, (_match, name: string) => {
    if (name === 'API_TOKEN') return runtimeState.apiToken || 'replace-me';
    if (name === 'API_KEY') return runtimeState.apiKey || 'replace-me';
    if (name === 'CSRF_TOKEN') return runtimeState.csrfToken || 'replace-me';
    if (name === 'SESSION_COOKIE') return runtimeState.sessionCookie || 'replace-me';
    return runtimeState.values[name] ?? 'replace-me';
  });

/** Deep-resolve {{NAME}} tokens in string leaves of a query/body value. */
const resolveDeep = (value: unknown, runtimeState: RuntimeExecutionState): unknown => {
  if (typeof value === 'string') {
    return resolveTemplateValue(value, runtimeState);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, runtimeState));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, child]) => {
      acc[key] = resolveDeep(child, runtimeState);
      return acc;
    }, {});
  }
  return value;
};

const AUTH_HEADER_RE = /^(authorization|cookie|x-api-key|x-csrf-token|csrf-token)$/i;

/**
 * The credential set to use for a given identity. `secondary` substitutes the foreign-user
 * tokens (for IDOR tests); `none` clears all credentials so an unauthenticated request is
 * issued and the auth-injection blocks below are skipped.
 */
const effectiveStateForIdentity = (
  runtimeState: RuntimeExecutionState,
  settings: ExtensionSettings,
  identity: RequestIdentity
): RuntimeExecutionState => {
  if (identity === 'none') {
    return { ...runtimeState, apiToken: '', apiKey: '', sessionCookie: '', csrfToken: '' };
  }
  if (identity === 'secondary') {
    return {
      ...runtimeState,
      apiToken: settings.runtimeSecondaryApiToken || '',
      apiKey: settings.runtimeSecondaryApiKey || '',
      sessionCookie: settings.runtimeSecondarySessionCookie || ''
    };
  }
  return runtimeState;
};

const buildHeaders = (
  headers: Record<string, string> | undefined,
  settings: ExtensionSettings,
  runtimeState: RuntimeExecutionState,
  identity: RequestIdentity = 'primary'
): Record<string, string> => {
  const state = effectiveStateForIdentity(runtimeState, settings, identity);

  const resolved = Object.entries(headers ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
    // For an explicit no-auth request, drop any auth-bearing custom headers entirely.
    if (identity === 'none' && AUTH_HEADER_RE.test(key)) {
      return acc;
    }
    acc[key] = resolveTemplateValue(value, state);
    return acc;
  }, {});

  // No credentials are injected for a deliberately unauthenticated request.
  if (identity === 'none') {
    return resolved;
  }

  if (settings.runtimeAuthMode === 'bearer' || settings.runtimeAuthMode === 'oauth2') {
    if (state.apiToken && !resolved.Authorization) {
      resolved.Authorization = `Bearer ${state.apiToken}`;
    }
  }

  if (settings.runtimeAuthMode === 'apiKey') {
    const headerName = settings.apiKeyHeaderName || 'X-API-Key';
    if (state.apiKey && !resolved[headerName]) {
      resolved[headerName] = state.apiKey;
    }
  }

  if (settings.runtimeAuthMode === 'cookieSession') {
    const cookieName = settings.sessionCookieName || 'session';
    if (state.sessionCookie && !resolved.Cookie) {
      resolved.Cookie = `${cookieName}=${state.sessionCookie}`;
    }
  }

  if (settings.csrfHeaderName && state.csrfToken && !resolved[settings.csrfHeaderName]) {
    resolved[settings.csrfHeaderName] = state.csrfToken;
  }

  return resolved;
};

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, unknown>
): string => {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
};

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });

/**
 * Issue a request, retrying transient 429/5xx responses with exponential backoff (honoring
 * a `Retry-After` header when present). Disabled unless `settings.retryOnRateLimit` is set,
 * so a burst of generated requests no longer counts transient throttling as a real failure.
 */
const fetchWithRetry = async (
  url: string,
  init: Parameters<typeof fetchWithTimeout>[1],
  opts: Parameters<typeof fetchWithTimeout>[2],
  settings: ExtensionSettings,
  signal?: AbortSignal
): Promise<Response> => {
  const maxRetries = settings.retryOnRateLimit ? Math.max(0, settings.maxRetries ?? 2) : 0;
  let attempt = 0;
  for (;;) {
    const response = await fetchWithTimeout(url, init, opts);
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) {
      return response;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
    await sleep(waitMs, signal);
    attempt += 1;
  }
};

const typeMatches = (type: string, value: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    default:
      return value !== undefined;
  }
};

const checkConstraints = (schema: SchemaObject | SchemaField, value: unknown, path: string): string[] => {
  const issues: string[] = [];
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.some((allowed) => allowed === value)) {
    issues.push(`${path} value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push(`${path} ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push(`${path} ${value} is above maximum ${schema.maximum}`);
    }
  }
  const lengthOf = typeof value === 'string' ? value.length : Array.isArray(value) ? value.length : undefined;
  if (lengthOf !== undefined) {
    if (typeof schema.minLength === 'number' && lengthOf < schema.minLength) {
      issues.push(`${path} length ${lengthOf} is below minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && lengthOf > schema.maxLength) {
      issues.push(`${path} length ${lengthOf} is above maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === 'string' && schema.pattern) {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        issues.push(`${path} does not match pattern ${schema.pattern}`);
      }
    } catch {
      // Invalid pattern in schema — ignore rather than fail the test on our own regex error.
    }
  }
  return issues;
};

const validateSchemaValue = (schema: SchemaObject | SchemaField | undefined, value: unknown, path: string): string[] => {
  if (!schema) {
    return [];
  }

  const expectedType = schema.type;
  if (!typeMatches(expectedType, value)) {
    return [`${path} expected ${expectedType} but received ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`];
  }

  const constraintIssues = checkConstraints(schema, value, path);

  if ('properties' in schema && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const issues: string[] = [...constraintIssues];
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in objectValue)) {
        issues.push(`${path}.${requiredKey} is required`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in objectValue) {
        issues.push(...validateSchemaValue(childSchema, objectValue[key], `${path}.${key}`));
      }
    }
    return issues;
  }

  if ('items' in schema && schema.items && Array.isArray(value)) {
    return [
      ...constraintIssues,
      ...value.slice(0, 3).flatMap((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`))
    ];
  }

  return constraintIssues;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const normalizeJsonPath = (path: string): string[] =>
  path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

const getByPath = (value: unknown, path: string): unknown => {
  let cursor = value;
  for (const segment of normalizeJsonPath(path)) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const parseCookieValue = (headerValue: string | null, cookieName: string): string | undefined => {
  if (!headerValue) {
    return undefined;
  }

  const match = headerValue.match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`));
  return match?.[1];
};

const hasRequiredRuntimeValue = (
  tests: GeneratedTestCase[],
  runtimeState: RuntimeExecutionState,
  settings: ExtensionSettings
): string | null => {
  const allHeaderValues = tests.flatMap((test) => Object.values(test.request.headers ?? {}));
  const needsApiToken = allHeaderValues.some((value) => value.includes('{{API_TOKEN}}'))
    || settings.runtimeAuthMode === 'bearer'
    || settings.runtimeAuthMode === 'oauth2';
  const needsApiKey = allHeaderValues.some((value) => value.includes('{{API_KEY}}'))
    || settings.runtimeAuthMode === 'apiKey';
  const needsCsrf = allHeaderValues.some((value) => value.includes('{{CSRF_TOKEN}}'));
  const needsSession = allHeaderValues.some((value) => value.includes('{{SESSION_COOKIE}}'))
    || settings.runtimeAuthMode === 'cookieSession';

  if (needsApiToken && !runtimeState.apiToken) {
    return 'Live validation requires an API token or a setup flow that extracts one.';
  }
  if (needsApiKey && !runtimeState.apiKey) {
    return 'Live validation requires an API key or a setup flow that extracts one.';
  }
  if (needsCsrf && !runtimeState.csrfToken) {
    return 'Live validation requires a CSRF token or a setup flow that extracts one.';
  }
  if (needsSession && !runtimeState.sessionCookie) {
    return 'Live validation requires a session cookie or a setup flow that extracts one.';
  }
  return null;
};

const VOLATILE_KEY_RE = /(updated_?at|created_?at|timestamp|^time$|^date$|request_?id|trace_?id|etag|last_?modified)/i;

/** Drop fields that legitimately differ between two reads (timestamps, ids) before comparing. */
const stripVolatile = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_KEY_RE.test(key))
        .map(([key, child]) => [key, stripVolatile(child)])
    );
  }
  return value;
};

const jsonTypeName = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

/** Evaluate one executable body assertion; returns a failure message or null. */
const evaluateAssertion = (assertion: BodyAssertion, payload: unknown): string | null => {
  const actual = assertion.path ? getByPath(payload, assertion.path) : payload;
  const label = assertion.path || '<root>';
  const { op, value } = assertion;
  switch (op) {
    case 'exists':
      return actual === undefined || actual === null ? `${label} expected to exist` : null;
    case 'absent':
      return actual !== undefined && actual !== null ? `${label} expected to be absent` : null;
    case 'equals':
      return JSON.stringify(actual) === JSON.stringify(value) ? null : `${label} expected ${JSON.stringify(value)} but was ${JSON.stringify(actual)}`;
    case 'type':
      return jsonTypeName(actual) === String(value) ? null : `${label} expected type ${String(value)} but was ${jsonTypeName(actual)}`;
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(value)) ? null : `${label} did not contain ${String(value)}`;
      if (Array.isArray(actual)) return actual.some((item) => JSON.stringify(item) === JSON.stringify(value)) ? null : `${label} did not contain ${JSON.stringify(value)}`;
      return `${label} is not a string/array for contains`;
    case 'matches':
      try {
        return new RegExp(String(value)).test(String(actual)) ? null : `${label} did not match /${String(value)}/`;
      } catch {
        return null;
      }
    case 'gt':
      return Number(actual) > Number(value) ? null : `${label} (${String(actual)}) not > ${String(value)}`;
    case 'gte':
      return Number(actual) >= Number(value) ? null : `${label} (${String(actual)}) not >= ${String(value)}`;
    case 'lt':
      return Number(actual) < Number(value) ? null : `${label} (${String(actual)}) not < ${String(value)}`;
    case 'lte':
      return Number(actual) <= Number(value) ? null : `${label} (${String(actual)}) not <= ${String(value)}`;
    case 'in':
      return Array.isArray(value) && value.some((allowed) => JSON.stringify(allowed) === JSON.stringify(actual)) ? null : `${label} (${JSON.stringify(actual)}) not in ${JSON.stringify(value)}`;
    case 'length': {
      const len = typeof actual === 'string' || Array.isArray(actual) ? actual.length : 0;
      return len === Number(value) ? null : `${label} length ${len} != ${String(value)}`;
    }
    default:
      return null;
  }
};

const validateContracts = (test: GeneratedTestCase, endpoint: ApiEndpoint, payload: unknown): ValidationFailure[] => {
  const failures: ValidationFailure[] = [];

  for (const assertion of test.expected.bodyAssertions ?? []) {
    if (payload === undefined) {
      failures.push({ type: 'contract', message: 'Response body could not be parsed for body assertions.' });
      break;
    }
    const failure = evaluateAssertion(assertion, payload);
    if (failure) {
      failures.push({ type: 'contract', message: failure, expected: assertion.op, actual: assertion.path });
    }
  }

  if (test.expected.pagination) {
    // A list endpoint is "paginated-shaped" if it's an array, has a conventional
    // items/results/data envelope, OR has any array-valued key (domain wrappers like
    // {"events": [...]} or {"alerts": [...]} are common and were previously missed).
    const paginated = Array.isArray(payload)
      || (
        Boolean(payload)
        && typeof payload === 'object'
        && (
          ['items', 'results', 'data'].some((key) => key in (payload as Record<string, unknown>))
          || Object.values(payload as Record<string, unknown>).some((entry) => Array.isArray(entry))
        )
      );
    if (!paginated) {
      failures.push({
        type: 'pagination',
        message: 'Expected paginated/list response structure.',
        expected: 'array or object with a list-valued field (e.g. items/results/data or a domain key)'
      });
    }
  }

  if (test.expected.idempotent && !['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method)) {
    failures.push({
      type: 'idempotency',
      message: 'Test marks a non-idempotent method as idempotent.',
      expected: 'idempotent HTTP method'
    });
  }

  if ((test.expected.contractChecks?.length ?? 0) > 0 && payload === undefined) {
    failures.push({
      type: 'contract',
      message: 'Response body could not be parsed for contract checks.'
    });
  }

  if (test.category === 'security' && test.expected.status < 400) {
    failures.push({
      type: 'auth',
      message: 'Security tests should assert an auth/authorization failure status.',
      expected: '4xx status'
    });
  }

  return failures;
};

const executeSetupSteps = async (
  settings: ExtensionSettings,
  runtimeState: RuntimeExecutionState,
  signal?: AbortSignal
): Promise<{ runtimeState: RuntimeExecutionState; warnings: string[]; results: ValidationSetupStepResult[] }> => {
  const warnings: string[] = [];
  const results: ValidationSetupStepResult[] = [];
  const steps = settings.runtimeSetupSteps ?? [];

  if (!settings.baseUrl || !steps.length) {
    return { runtimeState, warnings, results };
  }

  for (const step of steps) {
    const startedAt = Date.now();
    const extracted: string[] = [];
    let status: number | undefined;
    let responseSnippet = '';

    try {
      const stepPath = resolveTemplateValue(step.path, runtimeState);
      const stepQuery = resolveDeep(step.query ?? {}, runtimeState) as Record<string, unknown>;
      const stepBody = step.body === undefined || step.body === null
        ? undefined
        : resolveDeep(step.body, runtimeState);

      const response = await fetchWithTimeout(
        buildUrl(settings.baseUrl, stepPath, stepQuery),
        {
          method: step.method,
          headers: {
            'Content-Type': 'application/json',
            ...buildHeaders(step.headers, settings, runtimeState)
          },
          body: stepBody === undefined ? undefined : JSON.stringify(stepBody)
        },
        {
          timeoutMs: Math.max(10_000, Math.min(settings.timeoutMs, 60_000)),
          hardTimeoutMs: Math.max(20_000, Math.min(settings.timeoutMs * 2, 90_000)),
          parentSignal: signal
        }
      );

      status = response.status;
      const text = await response.text();
      responseSnippet = snippet(text);
      const json = safeJsonParse(text);

      if (step.expectedStatus !== undefined && response.status !== step.expectedStatus) {
        results.push({
          id: step.id,
          name: step.name,
          success: false,
          durationMs: Date.now() - startedAt,
          status,
          extracted,
          message: `Expected HTTP ${step.expectedStatus} but received ${response.status}.`,
          responseSnippet
        });
        continue;
      }

      for (const [key, path] of Object.entries(step.extractJsonPaths ?? {})) {
        if (!path) {
          continue;
        }
        const value = getByPath(json, path);
        if (typeof value === 'string') {
          if (key === 'apiToken') runtimeState.apiToken = value;
          if (key === 'apiKey') runtimeState.apiKey = value;
          if (key === 'csrfToken') runtimeState.csrfToken = value;
          if (key === 'sessionCookie') runtimeState.sessionCookie = value;
          extracted.push(key);
        } else {
          warnings.push(`Setup step "${step.name}" did not find JSON path "${path}" for ${key}.`);
        }
      }

      for (const [key, headerName] of Object.entries(step.extractHeaders ?? {})) {
        if (!headerName) {
          continue;
        }
        const value = response.headers.get(headerName);
        if (value) {
          if (key === 'apiToken') runtimeState.apiToken = value;
          if (key === 'apiKey') runtimeState.apiKey = value;
          if (key === 'csrfToken') runtimeState.csrfToken = value;
          if (key === 'sessionCookie') runtimeState.sessionCookie = value;
          extracted.push(key);
        } else {
          warnings.push(`Setup step "${step.name}" did not find response header "${headerName}" for ${key}.`);
        }
      }

      // Generic named-value capture for resource chaining: store any extracted value
      // under its placeholder name so later steps and the test suite can reference it
      // as {{NAME}}.
      for (const [name, path] of Object.entries(step.extractValues ?? {})) {
        if (!path) {
          continue;
        }
        const value = getByPath(json, path);
        if (value !== undefined && value !== null) {
          runtimeState.values[name] = String(value);
          extracted.push(name);
        } else {
          warnings.push(`Setup step "${step.name}" did not find JSON path "${path}" for {{${name}}}.`);
        }
      }

      if (step.extractCookieName) {
        const cookieValue = parseCookieValue(response.headers.get('set-cookie'), step.extractCookieName);
        if (cookieValue) {
          runtimeState.sessionCookie = cookieValue;
          extracted.push('sessionCookie');
        } else {
          warnings.push(`Setup step "${step.name}" could not read cookie "${step.extractCookieName}" from the response.`);
        }
      }

      results.push({
        id: step.id,
        name: step.name,
        success: true,
        durationMs: Date.now() - startedAt,
        status,
        extracted,
        responseSnippet
      });
    } catch (error) {
      results.push({
        id: step.id,
        name: step.name,
        success: false,
        durationMs: Date.now() - startedAt,
        status,
        extracted,
        message: error instanceof Error ? error.message : 'Unknown setup flow failure.',
        responseSnippet
      });
      warnings.push(`Setup step "${step.name}" failed and validation may use incomplete runtime credentials.`);
    }
  }

  return { runtimeState, warnings, results };
};

const buildSkippedSummary = (
  tests: GeneratedTestCase[],
  notRunReason: string,
  warnings: string[] = [],
  setupSteps: ValidationSetupStepResult[] = []
): ValidationSummary => ({
  attempted: 0,
  passed: 0,
  failed: 0,
  repaired: 0,
  skipped: tests.length,
  lastValidatedAt: Date.now(),
  results: [],
  warnings,
  notRunReason,
  setupSteps
});

export const validateGeneratedTestsAgainstBaseUrl = async (
  settings: ExtensionSettings,
  tests: GeneratedTestCase[],
  endpoints: ApiEndpoint[],
  signal?: AbortSignal
): Promise<ValidationSummary> => {
  if (!settings.baseUrl) {
    return buildSkippedSummary(tests, 'Live validation skipped because Base URL is not configured.');
  }

  const runtimeState = createRuntimeState(settings);
  const setupExecution = await executeSetupSteps(settings, runtimeState, signal);

  const failedSetup = setupExecution.results.find((result) => !result.success);
  if (failedSetup) {
    return buildSkippedSummary(
      tests,
      `Live validation skipped because setup step "${failedSetup.name}" failed.`,
      setupExecution.warnings,
      setupExecution.results
    );
  }

  // Missing auth is NOT a reason to skip the whole run — that's the point of running the
  // generated suite against the local service. Validate anyway and record a warning; tests
  // that genuinely need credentials will simply come back 401/403 (a real, useful result).
  const warnings = [...setupExecution.warnings];
  const missingPrereq = hasRequiredRuntimeValue(tests, runtimeState, settings);
  if (missingPrereq) {
    warnings.push(`${missingPrereq} Running anyway — endpoints that require it may return 401/403.`);
  }

  const endpointMap = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const results: ValidationResult[] = [];

  for (const test of tests) {
    const endpoint = endpointMap.get(test.endpointId);
    if (!endpoint) {
      continue;
    }

    const startedAt = Date.now();
    const failures: ValidationFailure[] = [];
    let status: number | undefined;
    let responseSnippet = '';

    try {
      // Resolve {{NAME}} placeholders (e.g. {{USER_ID}}) in the path, query, and body
      // from the runtime-value registry before issuing the request — this is what makes
      // id-bearing endpoints validate against real, seeded data instead of 404ing on a
      // fabricated id.
      const identity: RequestIdentity = test.request.identity ?? 'primary';
      const resolvedPath = resolveTemplateValue(test.request.path, runtimeState);
      const resolvedQuery = resolveDeep(test.request.query ?? {}, runtimeState) as Record<string, unknown>;
      const resolvedBody = test.request.body === undefined || test.request.body === null
        ? undefined
        : resolveDeep(test.request.body, runtimeState);
      const requestUrl = buildUrl(settings.baseUrl, resolvedPath, resolvedQuery);
      const requestInit = {
        method: test.request.method,
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(test.request.headers, settings, runtimeState, identity)
        },
        body: resolvedBody === undefined ? undefined : JSON.stringify(resolvedBody)
      };
      const timeoutOpts = {
        timeoutMs: Math.max(10_000, Math.min(settings.timeoutMs, 60_000)),
        hardTimeoutMs: Math.max(20_000, Math.min(settings.timeoutMs * 2, 90_000)),
        parentSignal: signal
      };

      const response = await fetchWithRetry(requestUrl, requestInit, timeoutOpts, settings, signal);

      status = response.status;
      const text = await response.text();
      responseSnippet = snippet(text);

      // Non-positive categories (negative/security/edge) only need to land in the right
      // status *class*; asserting an exact code on those produced false failures whenever
      // the model guessed e.g. 400 for an API that answers 422.
      if (!statusSatisfied(test, response.status)) {
        failures.push({
          type: test.category === 'security' ? 'auth' : 'status',
          message: `Expected HTTP ${statusExpectationLabel(test)} but received ${response.status}.`,
          expected: statusExpectationLabel(test),
          actual: String(response.status)
        });
      }

      for (const expectedText of test.expected.contains ?? []) {
        if (!text.includes(expectedText)) {
          failures.push({
            type: 'contains',
            message: `Response did not contain "${expectedText}".`,
            expected: expectedText,
            actual: responseSnippet
          });
        }
      }

      if (test.expected.contentType) {
        const responseType = response.headers.get('content-type') ?? '';
        if (!responseType.toLowerCase().includes(test.expected.contentType.toLowerCase())) {
          failures.push({
            type: 'header',
            message: `Expected content-type ${test.expected.contentType} but received ${responseType || 'none'}.`,
            expected: test.expected.contentType,
            actual: responseType || 'none'
          });
        }
      }

      for (const [headerName, headerValue] of Object.entries(test.expected.responseHeaders ?? {})) {
        const actual = response.headers.get(headerName) ?? '';
        if (actual !== headerValue) {
          failures.push({
            type: 'header',
            message: `Expected response header ${headerName}=${headerValue} but received ${actual || 'none'}.`,
            expected: headerValue,
            actual: actual || 'none'
          });
        }
      }

      let parsedPayload: unknown;
      if ((test.expected.jsonSchema || test.expected.pagination || (test.expected.contractChecks?.length ?? 0) > 0) && text) {
        parsedPayload = safeJsonParse(text);
        if (parsedPayload === undefined) {
          failures.push({
            type: 'schema',
            message: 'Response was not valid JSON for schema/contract validation.'
          });
        }
      }

      if (test.expected.jsonSchema && parsedPayload !== undefined) {
        for (const schemaFailure of validateSchemaValue(test.expected.jsonSchema, parsedPayload, 'response')) {
          failures.push({
            type: 'schema',
            message: schemaFailure
          });
        }
      }

      failures.push(...validateContracts(test, endpoint, parsedPayload));

      // Real idempotency oracle: re-issue the request and require the same status and an
      // equivalent body (ignoring volatile fields). This replaces the old generated
      // `repeat.status < 500` check, which proved almost nothing.
      if (test.expected.idempotent && ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(test.request.method.toUpperCase())) {
        try {
          const repeat = await fetchWithRetry(requestUrl, requestInit, timeoutOpts, settings, signal);
          const repeatText = await repeat.text();
          if (repeat.status !== response.status) {
            failures.push({
              type: 'idempotency',
              message: `Idempotent repeat returned ${repeat.status}, first call returned ${response.status}.`,
              expected: String(response.status),
              actual: String(repeat.status)
            });
          } else {
            const firstJson = safeJsonParse(text);
            const repeatJson = safeJsonParse(repeatText);
            if (firstJson !== undefined && repeatJson !== undefined) {
              if (JSON.stringify(stripVolatile(firstJson)) !== JSON.stringify(stripVolatile(repeatJson))) {
                failures.push({
                  type: 'idempotency',
                  message: 'Idempotent repeat returned a different response body.'
                });
              }
            }
          }
        } catch {
          // A failed repeat shouldn't mask the primary result; the first call already recorded status.
        }
      }
    } catch (error) {
      failures.push({
        type: 'network',
        message: error instanceof Error ? error.message : 'Unknown validation failure.'
      });
    }

    results.push({
      endpointId: test.endpointId,
      title: test.title,
      success: failures.length === 0,
      durationMs: Date.now() - startedAt,
      status,
      failures,
      responseSnippet
    });
  }

  const passed = results.filter((result) => result.success).length;
  const failed = results.length - passed;

  return {
    attempted: results.length,
    passed,
    failed,
    repaired: 0,
    skipped: Math.max(tests.length - results.length, 0),
    lastValidatedAt: Date.now(),
    results,
    warnings,
    setupSteps: setupExecution.results
  };
};
