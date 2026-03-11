import { chunkArray } from '@background/utils/chunks';
import { getProviderAdapter } from '@background/llm/client';
import { getFrameworkAdapter } from './frameworks/registry';
import type {
  ApiEndpoint,
  BatchGenerationDiagnostics,
  BatchQualityAssessment,
  ExtensionSettings,
  GeneratedFile,
  GeneratedTestCase,
  GenerateContext,
  JobState,
  QualityIssue,
  RepoRef
} from '@shared/types';

interface GenerateOptions {
  settings: ExtensionSettings;
  repo: RepoRef;
  endpoints: ApiEndpoint[];
  initialTests?: GeneratedTestCase[];
  startBatch?: number;
  signal?: AbortSignal;
  onBatchComplete?: (progress: {
    completedBatches: number;
    totalBatches: number;
    generatedTests: GeneratedTestCase[];
    batchDiagnostics: BatchGenerationDiagnostics;
  }) => Promise<void>;
  onBatchHeartbeat?: (progress: {
    currentBatch: number;
    totalBatches: number;
    attempt: 'generate' | 'repair';
    elapsedMs: number;
    generatedTests: GeneratedTestCase[];
  }) => Promise<void>;
}

const METHOD_DEFAULTS: Record<string, number> = {
  GET: 200,
  POST: 201,
  PUT: 200,
  PATCH: 200,
  DELETE: 204,
  OPTIONS: 200,
  HEAD: 200
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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

const endpointPathToRegex = (path: string): RegExp => {
  const escaped = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+\*/g, '.+')
    .replace(/:\w+/g, '[^/]+')
    .replace(/\{[^}]+\}/g, '[^/]+');

  return new RegExp(`^${escaped}$`, 'i');
};

const hasPlaceholders = (path: string): boolean => /:\w|\{[^}]+\}/.test(path);

const sampleValueForParam = (name: string, type?: string, format?: string): string => {
  const normalizedName = name.toLowerCase();
  const normalizedType = (type ?? '').toLowerCase();
  const normalizedFormat = (format ?? '').toLowerCase();

  if (normalizedFormat === 'uuid' || normalizedName.includes('uuid')) {
    return '00000000-0000-4000-8000-000000000000';
  }
  if (normalizedType === 'integer' || normalizedType === 'number' || normalizedName.endsWith('id') || normalizedName === 'id') {
    return '1';
  }
  if (normalizedType === 'boolean') {
    return 'true';
  }

  return `${normalizedName || 'sample'}-value`;
};

const buildExamplePath = (endpoint: ApiEndpoint): string => {
  const paramsByName = new Map(endpoint.pathParams.map((param) => [param.name, param]));

  return endpoint.path
    .replace(/:([A-Za-z0-9_]+)\*/g, (_match, name: string) => sampleValueForParam(name, paramsByName.get(name)?.type, paramsByName.get(name)?.format))
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => sampleValueForParam(name, paramsByName.get(name)?.type, paramsByName.get(name)?.format))
    .replace(/\{([^}]+)\}/g, (_match, name: string) => sampleValueForParam(name, paramsByName.get(name)?.type, paramsByName.get(name)?.format));
};

const normalizeRequestPath = (value: unknown, endpoint: ApiEndpoint): string => {
  const candidate = typeof value === 'string' ? value.trim().split('?')[0] : '';
  if (candidate && !hasPlaceholders(candidate) && endpointPathToRegex(endpoint.path).test(candidate)) {
    return candidate;
  }
  return buildExamplePath(endpoint);
};

const defaultExpectedStatus = (endpoint: ApiEndpoint): number => {
  const documented = endpoint.responses
    .map((response) => Number(response.status))
    .find((status) => Number.isFinite(status) && status >= 200 && status < 300);

  return documented ?? METHOD_DEFAULTS[endpoint.method] ?? 200;
};

const isCategoryApplicable = (endpoint: ApiEndpoint, category: GeneratedTestCase['category']): boolean => {
  if (category !== 'security') {
    return true;
  }
  return endpoint.auth !== 'none' || endpoint.method !== 'GET';
};

const endpointNeedsConcretePathValues = (endpoint: ApiEndpoint): boolean => hasPlaceholders(endpoint.path);

const createIssue = (
  code: QualityIssue['code'],
  severity: QualityIssue['severity'],
  message: string,
  endpointId?: string,
  category?: QualityIssue['category']
): QualityIssue => ({
  code,
  severity,
  message,
  endpointId,
  category
});

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

const titleIsGeneric = (title: string, endpoint: ApiEndpoint): boolean => {
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
      issues.push(createIssue(
        'missing-endpoint-tests',
        'error',
        `Missing all tests for ${endpoint.method} ${endpoint.path}`,
        endpoint.id
      ));
      continue;
    }

    for (const category of requiredCategories) {
      if (!isCategoryApplicable(endpoint, category as GeneratedTestCase['category'])) {
        continue;
      }

      if (!endpointTests.some((test) => test.category === category)) {
        issues.push(createIssue(
          'missing-category',
          'error',
          `Missing ${category} test for ${endpoint.method} ${endpoint.path}`,
          endpoint.id,
          category as QualityIssue['category']
        ));
      }
    }

    if (
      endpointNeedsConcretePathValues(endpoint) &&
      !endpointTests.some((test) => test.request.path !== endpoint.path && !hasPlaceholders(test.request.path))
    ) {
      issues.push(createIssue(
        'unresolved-path',
        'error',
        `No concrete path values generated for ${endpoint.method} ${endpoint.path}`,
        endpoint.id
      ));
    }

    for (const test of endpointTests) {
      if (!statusAllowedForEndpoint(endpoint, test)) {
        issues.push(createIssue(
          'invalid-status',
          'error',
          `Unexpected status ${test.expected.status} for ${endpoint.method} ${endpoint.path}`,
          endpoint.id,
          test.category
        ));
      }

      if (titleIsGeneric(test.title, endpoint)) {
        issues.push(createIssue(
          'generic-title',
          'error',
          `Generic title for ${endpoint.method} ${endpoint.path}: "${test.title}"`,
          endpoint.id,
          test.category
        ));
      }

      if (securityTestLooksWeak(endpoint, test)) {
        issues.push(createIssue(
          'weak-security',
          'error',
          `Weak security behavior for ${endpoint.method} ${endpoint.path}`,
          endpoint.id,
          test.category
        ));
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues: issues.slice(0, 20)
  };
};

export class BatchGenerationError extends Error {
  readonly diagnostics: BatchGenerationDiagnostics;

  constructor(diagnostics: BatchGenerationDiagnostics) {
    super(`Batch ${diagnostics.batchIndex + 1} failed quality gate`);
    this.name = 'BatchGenerationError';
    this.diagnostics = diagnostics;
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000;

const generateBatchWithRepair = async (
  providerAdapter: ReturnType<typeof getProviderAdapter>,
  batch: ApiEndpoint[],
  context: GenerateContext,
  options: Pick<GenerateOptions, 'settings' | 'signal' | 'onBatchHeartbeat'> & { batchIndex: number; totalBatches: number; generatedTests: GeneratedTestCase[] }
): Promise<{ tests: GeneratedTestCase[]; diagnostics: BatchGenerationDiagnostics }> => {
  const baseProviderOptions = {
    apiKey: getProviderKey(options.settings, options.settings.provider),
    model: options.settings.model,
    signal: options.signal,
    timeoutMs: options.settings.timeoutMs,
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
    promptMode: 'generate' as const
  };

  const makeHeartbeat = (attempt: 'generate' | 'repair') => {
    const startedAt = Date.now();
    return async (elapsedMs: number): Promise<void> => {
      if (options.onBatchHeartbeat) {
        await options.onBatchHeartbeat({
          currentBatch: options.batchIndex,
          totalBatches: options.totalBatches,
          attempt,
          elapsedMs,
          generatedTests: options.generatedTests
        });
      }
    };
  };

  const firstPass = await providerAdapter.generateTests(batch, context, { ...baseProviderOptions, onHeartbeat: makeHeartbeat('generate') });
  let normalized = normalizeGeneratedTests(firstPass.tests, options.settings.includeCategories, batch);
  let quality = assessGeneratedTestQuality(batch, normalized, options.settings.includeCategories);

  if (quality.passed) {
    return {
      tests: normalized,
      diagnostics: {
        batchIndex: options.batchIndex,
        endpointIds: batch.map((endpoint) => endpoint.id),
        provider: options.settings.provider,
        repairAttempted: false,
        assessment: quality
      }
    };
  }

  const repaired = await providerAdapter.generateTests(batch, context, {
    onHeartbeat: makeHeartbeat('repair'),
    ...baseProviderOptions,
    promptMode: 'repair',
    currentTests: normalized,
    repairIssues: quality.issues
  });

  const repairedNormalized = normalizeGeneratedTests(repaired.tests, options.settings.includeCategories, batch);
  const repairedQuality = assessGeneratedTestQuality(batch, repairedNormalized, options.settings.includeCategories);

  if (repairedQuality.passed || (repairedNormalized.length >= normalized.length && repairedQuality.issues.length <= quality.issues.length)) {
    normalized = repairedNormalized;
    quality = repairedQuality;
  }

  const diagnostics: BatchGenerationDiagnostics = {
    batchIndex: options.batchIndex,
    endpointIds: batch.map((endpoint) => endpoint.id),
    provider: options.settings.provider,
    repairAttempted: true,
    assessment: quality
  };

  if (!quality.passed) {
    throw new BatchGenerationError(diagnostics);
  }

  return { tests: normalized, diagnostics };
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

      if (endpoint.auth === 'bearer' && !('Authorization' in headers) && !('authorization' in headers)) {
        headers.Authorization = 'Bearer {{API_TOKEN}}';
      }

      const normalized: GeneratedTestCase = {
        endpointId: endpoint.id,
        category: allowedCategories.includes(category) ? (category as GeneratedTestCase['category']) : 'positive',
        title: String(source.title ?? `${endpoint.method} ${endpoint.path} generated test`),
        request: {
          method: endpoint.method,
          path: normalizeRequestPath(request.path, endpoint),
          headers,
          query: normalizeQuery(request.query),
          body: request.body
        },
        expected: {
          status: Number.isFinite(Number(expected.status)) ? Number(expected.status) : defaultExpectedStatus(endpoint),
          contains: Array.isArray(expected.contains)
            ? (expected.contains as string[])
                .map((value) => String(value))
                .filter(Boolean)
            : []
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

export interface GenerationResult {
  tests: GeneratedTestCase[];
  files: GeneratedFile[];
  totalBatches: number;
  diagnostics: BatchGenerationDiagnostics[];
}

export const renderGeneratedFiles = (
  settings: ExtensionSettings,
  repo: RepoRef,
  endpointCount: number,
  tests: GeneratedTestCase[]
): GeneratedFile[] => {
  const frameworkAdapter = getFrameworkAdapter(settings.framework);
  const projectMeta = {
    repo,
    generatedAt: new Date().toISOString(),
    framework: settings.framework,
    endpointCount
  };

  const files = frameworkAdapter.render(tests, projectMeta);
  files.push(frameworkAdapter.renderReadme(projectMeta));

  if (frameworkAdapter.renderSupportFiles) {
    files.push(...frameworkAdapter.renderSupportFiles(projectMeta));
  }

  return files;
};

export const generateTestSuite = async (options: GenerateOptions): Promise<GenerationResult> => {
  const providerAdapter = getProviderAdapter(options.settings.provider);

  const context: GenerateContext = {
    repo: options.repo,
    framework: options.settings.framework,
    includeCategories: options.settings.includeCategories,
    timeoutMs: options.settings.timeoutMs
  };

  const chunks = chunkArray(options.endpoints, options.settings.batchSize);
  const startBatch = Math.max(options.startBatch ?? 0, 0);
  const generatedTests: GeneratedTestCase[] = [...(options.initialTests ?? [])];
  const diagnostics: BatchGenerationDiagnostics[] = [];

  for (let index = startBatch; index < chunks.length; index += 1) {
    const batch = chunks[index];
    const result = await generateBatchWithRepair(providerAdapter, batch, context, {
      ...options,
      batchIndex: index,
      totalBatches: chunks.length,
      generatedTests: [...generatedTests]
    });
    generatedTests.push(...result.tests);
    diagnostics.push(result.diagnostics);

    if (options.onBatchComplete) {
      await options.onBatchComplete({
        completedBatches: index + 1,
        totalBatches: chunks.length,
        generatedTests: [...generatedTests],
        batchDiagnostics: result.diagnostics
      });
    }
  }

  const files = renderGeneratedFiles(options.settings, options.repo, options.endpoints.length, generatedTests);

  return {
    tests: generatedTests,
    files,
    totalBatches: chunks.length,
    diagnostics
  };
};

const getProviderKey = (settings: ExtensionSettings, provider: ExtensionSettings['provider']): string => {
  if (provider === 'openai') {
    return settings.openAiKey ?? '';
  }
  if (provider === 'claude') {
    return settings.claudeKey ?? '';
  }
  return settings.geminiKey ?? '';
};

export const applyGenerationProgressToJob = (job: JobState, progress: {
  completedBatches: number;
  totalBatches: number;
  generatedTests: GeneratedTestCase[];
  batchDiagnostics: BatchGenerationDiagnostics;
}): JobState => ({
  ...job,
  stage: 'generating',
  completedBatches: progress.completedBatches,
  totalBatches: progress.totalBatches,
  generatedTests: progress.generatedTests,
  batchDiagnostics: [...(job.batchDiagnostics ?? []), progress.batchDiagnostics],
  qualityStatus: 'pending',
  repairAttempts: (job.repairAttempts ?? 0) + (progress.batchDiagnostics.repairAttempted ? 1 : 0),
  progress: Math.max(job.progress, Math.round((progress.completedBatches / Math.max(progress.totalBatches, 1)) * 100)),
  statusText: `Generated batch ${progress.completedBatches}/${progress.totalBatches}`,
  updatedAt: Date.now()
});
