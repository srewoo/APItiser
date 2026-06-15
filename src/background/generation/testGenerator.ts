import { chunkArray } from '@background/utils/chunks';
import { loadProviderAdapter } from '@background/llm/client';
import { PROVIDER_MODELS } from '@shared/constants';
import { getFrameworkAdapter } from './frameworks/registry';
import {
  assessGeneratedTestQuality,
  mergeSafeRepairs,
  normalizeGeneratedTests
} from './qualityGate';
import type {
  ApiEndpoint,
  BatchGenerationDiagnostics,
  BatchQualityAssessment,
  ExtensionSettings,
  GeneratedFile,
  GeneratedTestCase,
  GenerateContext,
  JobState,
  ProjectMeta,
  QualityIssue,
  RepoRef,
  ValidationSummary
} from '@shared/types';

export { assessGeneratedTestQuality, normalizeGeneratedTests } from './qualityGate';

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
    /** 'generate' for the main pass, 'backfill' for the coverage-completion pass. */
    phase: 'generate' | 'backfill';
    elapsedMs: number;
    generatedTests: GeneratedTestCase[];
  }) => Promise<void>;
}

export class BatchGenerationError extends Error {
  constructor(
    public readonly diagnostics: BatchGenerationDiagnostics,
    public readonly partialTests: GeneratedTestCase[]
  ) {
    super(`Batch ${diagnostics.batchIndex + 1} failed quality gate`);
    this.name = 'BatchGenerationError';
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000;

const getProviderKey = (settings: ExtensionSettings, provider: ExtensionSettings['provider']): string => {
  if (provider === 'openai') {
    return settings.openAiKey ?? '';
  }
  if (provider === 'claude') {
    return settings.claudeKey ?? '';
  }
  return settings.geminiKey ?? '';
};

/**
 * Resolve the model id to send to a given provider. The configured `settings.model`
 * only matches the configured `settings.provider`; during provider fallback we must
 * NOT send (for example) an OpenAI model id to Claude. Use the configured model for
 * the configured provider, and that provider's default model otherwise.
 */
const resolveModelForProvider = (settings: ExtensionSettings, provider: ExtensionSettings['provider']): string => {
  if (provider === settings.provider && settings.model) {
    return settings.model;
  }
  return PROVIDER_MODELS[provider]?.[0] ?? settings.model;
};

const generateBatchWithRepair = async (
  providerAdapter: Awaited<ReturnType<typeof loadProviderAdapter>>,
  batch: ApiEndpoint[],
  context: GenerateContext,
  options: Pick<GenerateOptions, 'settings' | 'signal' | 'onBatchHeartbeat'> & { provider: ExtensionSettings['provider']; batchIndex: number; totalBatches: number; generatedTests: GeneratedTestCase[]; phase?: 'generate' | 'backfill' }
): Promise<{ tests: GeneratedTestCase[]; diagnostics: BatchGenerationDiagnostics }> => {
  const baseProviderOptions = {
    apiKey: getProviderKey(options.settings, options.provider),
    model: resolveModelForProvider(options.settings, options.provider),
    temperature: options.settings.temperature,
    signal: options.signal,
    timeoutMs: options.settings.timeoutMs,
    hardTimeoutMs: options.settings.timeoutMs * 2,
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
    promptMode: 'generate' as const
  };

  const makeHeartbeat = (attempt: 'generate' | 'repair') => {
    return async (elapsedMs: number): Promise<void> => {
      if (options.onBatchHeartbeat) {
        await options.onBatchHeartbeat({
          currentBatch: options.batchIndex,
          totalBatches: options.totalBatches,
          attempt,
          phase: options.phase ?? 'generate',
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
        provider: options.provider,
        repairAttempted: false,
        assessment: quality
      }
    };
  }

  const MAX_REPAIR_ATTEMPTS = 3;
  let repairCount = 0;

  while (!quality.passed && repairCount < MAX_REPAIR_ATTEMPTS) {
    repairCount += 1;
    const repaired = await providerAdapter.generateTests(batch, context, {
      onHeartbeat: makeHeartbeat('repair'),
      ...baseProviderOptions,
      promptMode: 'repair',
      currentTests: normalized,
      repairIssues: quality.issues
    });

    const repairedNormalized = normalizeGeneratedTests(repaired.tests, options.settings.includeCategories, batch);
    const constrainedRepair = mergeSafeRepairs(normalized, repairedNormalized, batch, quality.issues);
    const repairedQuality = assessGeneratedTestQuality(batch, constrainedRepair, options.settings.includeCategories);

    if (repairedQuality.passed || (constrainedRepair.length >= normalized.length && repairedQuality.issues.length <= quality.issues.length)) {
      normalized = constrainedRepair;
      quality = repairedQuality;
    }
  }

  const diagnostics: BatchGenerationDiagnostics = {
    batchIndex: options.batchIndex,
    endpointIds: batch.map((endpoint) => endpoint.id),
    provider: options.provider,
    repairAttempted: repairCount > 0,
    assessment: quality
  };

  if (!quality.passed) {
    throw new BatchGenerationError(diagnostics, normalized);
  }

  return { tests: normalized, diagnostics };
};

export interface GenerationResult {
  tests: GeneratedTestCase[];
  files: GeneratedFile[];
  totalBatches: number;
  diagnostics: BatchGenerationDiagnostics[];
  /** Assessment over ALL endpoints after generation + coverage backfill. */
  finalAssessment: BatchQualityAssessment;
}

/**
 * Endpoints that still have an error-severity quality issue (no tests at all, or a missing
 * required category). These are the endpoints the coverage-completion pass must target.
 */
const endpointsWithErrors = (
  endpoints: ApiEndpoint[],
  tests: GeneratedTestCase[],
  categories: string[]
): ApiEndpoint[] => {
  const assessment = assessGeneratedTestQuality(endpoints, tests, categories);
  const failing = new Set(
    assessment.issues.filter((issue) => issue.severity === 'error' && issue.endpointId).map((issue) => issue.endpointId as string)
  );
  return endpoints.filter((endpoint) => failing.has(endpoint.id));
};

const dedupeTests = (tests: GeneratedTestCase[]): GeneratedTestCase[] => {
  const seen = new Set<string>();
  return tests.filter((test) => {
    const key = [test.endpointId, test.category, test.title, test.request.method, test.request.path, test.expected.status].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export const renderGeneratedFiles = (
  settings: ExtensionSettings,
  repo: RepoRef,
  endpointCount: number,
  tests: GeneratedTestCase[],
  options?: {
    readiness?: ProjectMeta['readiness'];
    readinessNotes?: ProjectMeta['readinessNotes'];
    validationSummary?: ProjectMeta['validationSummary'];
  }
): GeneratedFile[] => {
  const frameworkAdapter = getFrameworkAdapter(settings.framework);
  const projectMeta = {
    repo,
    generatedAt: new Date().toISOString(),
    framework: settings.framework,
    endpointCount,
    readiness: options?.readiness,
    readinessNotes: options?.readinessNotes,
    validationSummary: options?.validationSummary
  };

  const files = frameworkAdapter.render(tests, projectMeta);
  files.push(frameworkAdapter.renderReadme(projectMeta));

  if (frameworkAdapter.renderSupportFiles) {
    files.push(...frameworkAdapter.renderSupportFiles(projectMeta));
  }

  // Surface any {{NAME}} runtime placeholders used in generated paths/queries/bodies as
  // env vars so the suite is runnable without hunting through each test for what to set.
  const AUTH_TOKENS = new Set(['API_TOKEN', 'API_KEY', 'CSRF_TOKEN', 'SESSION_COOKIE']);
  const runtimeTokenNames = new Set<string>();
  for (const test of tests) {
    const haystack = [
      test.request.path,
      JSON.stringify(test.request.query ?? {}),
      JSON.stringify(test.request.body ?? null),
      // Header values carry auth placeholders too (e.g. an x-token header rendered as
      // {{xtoken}}); without scanning them a required env var would be missing here.
      JSON.stringify(test.request.headers ?? {})
    ].join(' ');
    for (const match of haystack.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!AUTH_TOKENS.has(match[1])) {
        runtimeTokenNames.add(match[1]);
      }
    }
  }

  files.push({
    path: '.env.example',
    content: [
      'API_BASE_URL=http://localhost:3000',
      'API_TOKEN=your_token_here',
      'API_KEY=your_api_key_here',
      'CSRF_TOKEN=your_csrf_token_here',
      'SESSION_COOKIE=your_session_cookie_here',
      ...[...runtimeTokenNames].sort().map((name) => `${name}=replace-with-real-value`)
    ].join('\n') + '\n'
  });

  files.push({
    path: 'validation-report.json',
    content: JSON.stringify(
      {
        generatedAt: projectMeta.generatedAt,
        repo: `${repo.owner}/${repo.repo}`,
        framework: settings.framework,
        readiness: projectMeta.readiness ?? 'review_required',
        readinessNotes: projectMeta.readinessNotes ?? [],
        validationSummary: projectMeta.validationSummary ?? null,
        testCount: tests.length
      },
      null,
      2
    )
  });

  return files;
};

const validationFailuresToIssues = (summary: ValidationSummary, endpointId: string): QualityIssue[] => {
  const endpointResults = summary.results.filter((result) => result.endpointId === endpointId && !result.success);
  return endpointResults.flatMap((result) =>
    result.failures.map((failure) => ({
      code: failure.type === 'auth' ? 'execution-auth' as const : failure.type === 'status' ? 'execution-status' as const : 'execution-body' as const,
      severity: 'error' as const,
      message: `${result.title}: ${failure.message}`,
      endpointId
    }))
  );
};

export const repairTestsFromValidation = async (options: {
  settings: ExtensionSettings;
  repo: RepoRef;
  endpoints: ApiEndpoint[];
  tests: GeneratedTestCase[];
  validationSummary: ValidationSummary;
  signal?: AbortSignal;
}): Promise<GeneratedTestCase[]> => {
  const failingEndpointIds = [...new Set(options.validationSummary.results.filter((result) => !result.success).map((result) => result.endpointId))];
  if (!failingEndpointIds.length) {
    return options.tests;
  }

  const context: GenerateContext = {
    repo: options.repo,
    framework: options.settings.framework,
    includeCategories: options.settings.includeCategories,
    timeoutMs: options.settings.timeoutMs,
    customPromptInstructions: options.settings.customPromptInstructions,
    baseUrl: options.settings.baseUrl
  };

  const chunks = chunkArray(
    options.endpoints.filter((endpoint) => failingEndpointIds.includes(endpoint.id)),
    options.settings.batchSize
  );
  const stableTests = options.tests.filter((test) => !failingEndpointIds.includes(test.endpointId));
  const repairedTests: GeneratedTestCase[] = [];
  const allProviders: Array<ExtensionSettings['provider']> = ['openai', 'claude', 'gemini'];
  const providersToTry = options.settings.enableProviderFallback
    ? [options.settings.provider, ...allProviders.filter((provider) => provider !== options.settings.provider)]
    : [options.settings.provider];

  for (const batch of chunks) {
    const endpointIds = new Set(batch.map((endpoint) => endpoint.id));
    const currentTests = options.tests.filter((test) => endpointIds.has(test.endpointId));
    const repairIssues = batch.flatMap((endpoint) => validationFailuresToIssues(options.validationSummary, endpoint.id));
    let repairedBatch: GeneratedTestCase[] | null = null;

    for (const provider of providersToTry) {
      const apiKey = getProviderKey(options.settings, provider);
      if (!apiKey) {
        continue;
      }

      try {
        const adapter = await loadProviderAdapter(provider);
        const generated = await adapter.generateTests(batch, context, {
          apiKey,
          model: resolveModelForProvider(options.settings, provider),
          temperature: options.settings.temperature,
          signal: options.signal,
          timeoutMs: options.settings.timeoutMs,
          hardTimeoutMs: options.settings.timeoutMs * 2,
          promptMode: 'repair',
          currentTests,
          repairIssues
        });
        repairedBatch = mergeSafeRepairs(
          currentTests,
          normalizeGeneratedTests(generated.tests, options.settings.includeCategories, batch),
          batch,
          repairIssues
        );
        if (repairedBatch.length) {
          break;
        }
      } catch (error) {
        console.warn('[APItiser] Validation repair failed for batch.', error);
      }
    }

    repairedTests.push(...(repairedBatch?.length ? repairedBatch : currentTests));
  }

  return [...stableTests, ...repairedTests];
};

export const generateTestSuite = async (options: GenerateOptions): Promise<GenerationResult> => {
  const context: GenerateContext = {
    repo: options.repo,
    framework: options.settings.framework,
    includeCategories: options.settings.includeCategories,
    timeoutMs: options.settings.timeoutMs,
    customPromptInstructions: options.settings.customPromptInstructions,
    baseUrl: options.settings.baseUrl
  };

  const chunks = chunkArray(options.endpoints, options.settings.batchSize);
  const startBatch = Math.max(options.startBatch ?? 0, 0);
  const generatedTests: GeneratedTestCase[] = [...(options.initialTests ?? [])];
  const diagnostics: BatchGenerationDiagnostics[] = [];

  const allProviders: Array<ExtensionSettings['provider']> = ['openai', 'claude', 'gemini'];
  const providersToTry = options.settings.enableProviderFallback
    ? [options.settings.provider, ...allProviders.filter((p) => p !== options.settings.provider)]
    : [options.settings.provider];

  for (let index = startBatch; index < chunks.length; index += 1) {
    const batch = chunks[index];
    let result: Awaited<ReturnType<typeof generateBatchWithRepair>> | null = null;
    let partialTests: GeneratedTestCase[] | null = null;
    let partialDiagnostics: BatchGenerationDiagnostics | null = null;
    let lastError: unknown = null;

    for (const provider of providersToTry) {
      if (!getProviderKey(options.settings, provider)) {
        continue;
      }
      try {
        const adapter = await loadProviderAdapter(provider);
        result = await generateBatchWithRepair(adapter, batch, context, {
          ...options,
          provider,
          batchIndex: index,
          totalBatches: chunks.length,
          generatedTests: [...generatedTests]
        });
        break;
      } catch (err) {
        lastError = err;
        if (err instanceof BatchGenerationError) {
          partialTests = err.partialTests;
          partialDiagnostics = err.diagnostics;
          console.warn(`[APItiser] Batch ${index} quality failed with ${provider}. Trying fallback...`);
        } else {
          console.warn(`[APItiser] Batch ${index} failed with ${provider}.`, err);
        }
      }
    }

    if (!result) {
      if (partialTests && partialDiagnostics) {
        console.warn(`[APItiser] Keeping partial tests for batch ${index} despite quality failure.`);
        generatedTests.push(...partialTests);
        diagnostics.push(partialDiagnostics);
      } else {
        throw lastError || new Error(`Generation failed for batch ${index}. Configuration may be missing or all providers failed.`);
      }
    } else {
      generatedTests.push(...result.tests);
      diagnostics.push(result.diagnostics);
    }

    if (options.onBatchComplete) {
      await options.onBatchComplete({
        completedBatches: index + 1,
        totalBatches: chunks.length,
        generatedTests: [...generatedTests],
        batchDiagnostics: result ? result.diagnostics : partialDiagnostics!
      });
    }
  }

  // Coverage-completion pass. The main loop can leave endpoints with zero tests or a
  // missing category — usually because a large batch's JSON was truncated by the output
  // token limit, or the model simply omitted some endpoints. Re-generate the still-failing
  // endpoints in SMALL batches (so each gets ample token budget) until coverage is complete
  // or we stop making progress.
  const MAX_COVERAGE_ROUNDS = 3;
  for (let round = 0; round < MAX_COVERAGE_ROUNDS; round += 1) {
    const missing = endpointsWithErrors(options.endpoints, generatedTests, options.settings.includeCategories);
    if (!missing.length) {
      break;
    }
    const before = generatedTests.length;
    const backfillChunks = chunkArray(missing, Math.max(1, Math.min(2, options.settings.batchSize)));

    for (let chunkIndex = 0; chunkIndex < backfillChunks.length; chunkIndex += 1) {
      const batch = backfillChunks[chunkIndex];
      for (const provider of providersToTry) {
        if (!getProviderKey(options.settings, provider)) {
          continue;
        }
        try {
          const adapter = await loadProviderAdapter(provider);
          const result = await generateBatchWithRepair(adapter, batch, context, {
            ...options,
            provider,
            phase: 'backfill',
            // Kept in-range; the 'backfill' phase drives a distinct status message rather
            // than an "N/total" batch counter (which would otherwise read e.g. "16/12").
            batchIndex: Math.max(0, chunks.length - 1),
            totalBatches: chunks.length,
            generatedTests: [...generatedTests]
          });
          generatedTests.push(...result.tests);
          break;
        } catch (err) {
          if (err instanceof BatchGenerationError) {
            // Keep whatever the repair loop salvaged so partial coverage still improves.
            generatedTests.push(...err.partialTests);
            break;
          }
          console.warn('[APItiser] Coverage backfill batch failed.', err);
        }
      }
    }

    const deduped = dedupeTests(generatedTests);
    generatedTests.length = 0;
    generatedTests.push(...deduped);

    if (generatedTests.length <= before) {
      // No new tests this round — avoid looping forever on endpoints the model can't cover.
      break;
    }
  }

  const finalTests = dedupeTests(generatedTests);
  const finalAssessment = assessGeneratedTestQuality(options.endpoints, finalTests, options.settings.includeCategories);
  const files = renderGeneratedFiles(options.settings, options.repo, options.endpoints.length, finalTests);

  return {
    tests: finalTests,
    files,
    totalBatches: chunks.length,
    diagnostics,
    finalAssessment
  };
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
