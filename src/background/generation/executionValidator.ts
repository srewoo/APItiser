import { fetchWithTimeout } from '@background/llm/fetchWithTimeout';
import type {
  ApiEndpoint,
  ExtensionSettings,
  GeneratedTestCase,
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
}

const snippet = (value: string): string => value.slice(0, 240);

const createRuntimeState = (settings: ExtensionSettings): RuntimeExecutionState => ({
  apiToken: settings.runtimeApiToken || '',
  apiKey: settings.runtimeApiKey || '',
  csrfToken: settings.runtimeCsrfToken || '',
  sessionCookie: settings.runtimeSessionCookie || ''
});

const resolveTemplateValue = (value: string, runtimeState: RuntimeExecutionState): string => {
  if (value.includes('{{API_TOKEN}}')) {
    return value.replace('{{API_TOKEN}}', runtimeState.apiToken || 'replace-me');
  }
  if (value.includes('{{API_KEY}}')) {
    return value.replace('{{API_KEY}}', runtimeState.apiKey || 'replace-me');
  }
  if (value.includes('{{CSRF_TOKEN}}')) {
    return value.replace('{{CSRF_TOKEN}}', runtimeState.csrfToken || 'replace-me');
  }
  if (value.includes('{{SESSION_COOKIE}}')) {
    return value.replace('{{SESSION_COOKIE}}', runtimeState.sessionCookie || 'replace-me');
  }
  return value;
};

const buildHeaders = (
  headers: Record<string, string> | undefined,
  settings: ExtensionSettings,
  runtimeState: RuntimeExecutionState
): Record<string, string> => {
  const resolved = Object.entries(headers ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = resolveTemplateValue(value, runtimeState);
    return acc;
  }, {});

  if (settings.runtimeAuthMode === 'bearer' || settings.runtimeAuthMode === 'oauth2') {
    if (runtimeState.apiToken && !resolved.Authorization) {
      resolved.Authorization = `Bearer ${runtimeState.apiToken}`;
    }
  }

  if (settings.runtimeAuthMode === 'apiKey') {
    const headerName = settings.apiKeyHeaderName || 'X-API-Key';
    if (runtimeState.apiKey && !resolved[headerName]) {
      resolved[headerName] = runtimeState.apiKey;
    }
  }

  if (settings.runtimeAuthMode === 'cookieSession') {
    const cookieName = settings.sessionCookieName || 'session';
    if (runtimeState.sessionCookie && !resolved.Cookie) {
      resolved.Cookie = `${cookieName}=${runtimeState.sessionCookie}`;
    }
  }

  if (settings.csrfHeaderName && runtimeState.csrfToken && !resolved[settings.csrfHeaderName]) {
    resolved[settings.csrfHeaderName] = runtimeState.csrfToken;
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

const validateSchemaValue = (schema: SchemaObject | SchemaField | undefined, value: unknown, path: string): string[] => {
  if (!schema) {
    return [];
  }

  const expectedType = schema.type;
  if (!typeMatches(expectedType, value)) {
    return [`${path} expected ${expectedType} but received ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`];
  }

  if ('properties' in schema && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const issues: string[] = [];
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
    return value.slice(0, 3).flatMap((item, index) => validateSchemaValue(schema.items, item, `${path}[${index}]`));
  }

  return [];
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

const validateContracts = (test: GeneratedTestCase, endpoint: ApiEndpoint, payload: unknown): ValidationFailure[] => {
  const failures: ValidationFailure[] = [];

  if (test.expected.pagination) {
    const paginated = Array.isArray(payload)
      || (payload && typeof payload === 'object' && ['items', 'results', 'data'].some((key) => key in (payload as Record<string, unknown>)));
    if (!paginated) {
      failures.push({
        type: 'pagination',
        message: 'Expected paginated/list response structure.',
        expected: 'array or object with items/results/data'
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
      const response = await fetchWithTimeout(
        buildUrl(settings.baseUrl, step.path, step.query),
        {
          method: step.method,
          headers: {
            'Content-Type': 'application/json',
            ...buildHeaders(step.headers, settings, runtimeState)
          },
          body: step.body === undefined || step.body === null ? undefined : JSON.stringify(step.body)
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

  const missingPrereq = hasRequiredRuntimeValue(tests, runtimeState, settings);
  if (missingPrereq) {
    return buildSkippedSummary(tests, missingPrereq, setupExecution.warnings, setupExecution.results);
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
      const response = await fetchWithTimeout(
        buildUrl(settings.baseUrl, test.request.path, test.request.query),
        {
          method: test.request.method,
          headers: {
            'Content-Type': 'application/json',
            ...buildHeaders(test.request.headers, settings, runtimeState)
          },
          body: test.request.body === undefined || test.request.body === null ? undefined : JSON.stringify(test.request.body)
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

      if (response.status !== test.expected.status) {
        failures.push({
          type: test.category === 'security' ? 'auth' : 'status',
          message: `Expected HTTP ${test.expected.status} but received ${response.status}.`,
          expected: String(test.expected.status),
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
    warnings: setupExecution.warnings,
    setupSteps: setupExecution.results
  };
};
