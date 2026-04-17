import { chunkArray } from '@background/utils/chunks';
import { loadProviderAdapter } from '@background/llm/client';
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

const generateBatchWithRepair = async (
  providerAdapter: Awaited<ReturnType<typeof loadProviderAdapter>>,
  batch: ApiEndpoint[],
  context: GenerateContext,
  options: Pick<GenerateOptions, 'settings' | 'signal' | 'onBatchHeartbeat'> & { batchIndex: number; totalBatches: number; generatedTests: GeneratedTestCase[] }
): Promise<{ tests: GeneratedTestCase[]; diagnostics: BatchGenerationDiagnostics }> => {
  const baseProviderOptions = {
    apiKey: getProviderKey(options.settings, options.settings.provider),
    model: options.settings.model,
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
    provider: options.settings.provider,
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
}

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

  files.push({
    path: '.env.example',
    content: [
      'API_BASE_URL=http://localhost:3000',
      'API_TOKEN=your_token_here',
      'API_KEY=your_api_key_here',
      'CSRF_TOKEN=your_csrf_token_here',
      'SESSION_COOKIE=your_session_cookie_here'
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
          model: options.settings.model,
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

  const files = renderGeneratedFiles(options.settings, options.repo, options.endpoints.length, generatedTests);

  return {
    tests: generatedTests,
    files,
    totalBatches: chunks.length,
    diagnostics
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
