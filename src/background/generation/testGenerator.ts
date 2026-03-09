import { chunkArray } from '@background/utils/chunks';
import { getProviderAdapter } from '@background/llm/client';
import { getFrameworkAdapter } from './frameworks/registry';
import type {
  ApiEndpoint,
  ExtensionSettings,
  GeneratedFile,
  GeneratedTestCase,
  GenerateContext,
  JobState,
  RepoRef
} from '@shared/types';

interface GenerateOptions {
  settings: ExtensionSettings;
  repo: RepoRef;
  endpoints: ApiEndpoint[];
  initialTests?: GeneratedTestCase[];
  startBatch?: number;
  signal?: AbortSignal;
  onBatchComplete?: (progress: { completedBatches: number; totalBatches: number; generatedTests: GeneratedTestCase[] }) => Promise<void>;
}

const coerceGeneratedTests = (input: unknown, allowedCategories: string[]): GeneratedTestCase[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.reduce<GeneratedTestCase[]>((acc, item) => {
      if (!item || typeof item !== 'object') {
        return acc;
      }

      const source = item as Record<string, unknown>;
      const category = String(source.category ?? 'positive');
      const request = (source.request as Record<string, unknown> | undefined) ?? {};
      const expected = (source.expected as Record<string, unknown> | undefined) ?? {};

      const normalized: GeneratedTestCase = {
        endpointId: String(source.endpointId ?? ''),
        category: allowedCategories.includes(category) ? (category as GeneratedTestCase['category']) : 'positive',
        title: String(source.title ?? 'Generated test'),
        request: {
          method: String(request.method ?? 'GET').toUpperCase(),
          path: String(request.path ?? '/'),
          headers: (request.headers as Record<string, string>) ?? {},
          query: (request.query as Record<string, unknown>) ?? {},
          body: request.body
        },
        expected: {
          status: Number(expected.status ?? 200),
          contains: Array.isArray(expected.contains)
            ? (expected.contains as string[])
            : []
        }
      };

      if (normalized.endpointId) {
        acc.push(normalized);
      }
      return acc;
    }, []);
};

export interface GenerationResult {
  tests: GeneratedTestCase[];
  files: GeneratedFile[];
  totalBatches: number;
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

  for (let index = startBatch; index < chunks.length; index += 1) {
    const batch = chunks[index];
    const response = await providerAdapter.generateTests(batch, context, {
      apiKey: getProviderKey(options.settings, options.settings.provider),
      model: options.settings.model,
      signal: options.signal,
      timeoutMs: options.settings.timeoutMs
    });

    const normalized = coerceGeneratedTests(response.tests, options.settings.includeCategories);
    generatedTests.push(...normalized);

    if (options.onBatchComplete) {
      await options.onBatchComplete({
        completedBatches: index + 1,
        totalBatches: chunks.length,
        generatedTests: [...generatedTests]
      });
    }
  }

  const files = renderGeneratedFiles(options.settings, options.repo, options.endpoints.length, generatedTests);

  return {
    tests: generatedTests,
    files,
    totalBatches: chunks.length
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
}): JobState => ({
  ...job,
  stage: 'generating',
  completedBatches: progress.completedBatches,
  totalBatches: progress.totalBatches,
  generatedTests: progress.generatedTests,
  progress: Math.max(job.progress, Math.round((progress.completedBatches / Math.max(progress.totalBatches, 1)) * 100)),
  statusText: `Generated batch ${progress.completedBatches}/${progress.totalBatches}`,
  updatedAt: Date.now()
});
