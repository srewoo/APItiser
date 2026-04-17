import type {
  ApiEndpoint,
  AppState,
  ExtensionSettings,
  GeneratedArtifact,
  GeneratedTestCase,
  JobState,
  RepoRef,
  RunMetric,
  ValidationResult,
  ValidationSummary
} from '../types';

export const makeRepoRef = (overrides?: Partial<RepoRef>): RepoRef => ({
  platform: 'github',
  owner: 'acme',
  repo: 'test-api',
  branch: 'main',
  ...overrides
});

export const makeSettings = (overrides?: Partial<ExtensionSettings>): ExtensionSettings => ({
  provider: 'openai',
  model: 'gpt-4o-mini',
  framework: 'jest',
  includeCategories: ['positive', 'negative', 'edge', 'security'],
  testDirectories: ['tests', '__tests__'],
  skipExistingTests: false,
  batchSize: 6,
  timeoutMs: 120_000,
  openAiKey: 'sk-test-key',
  ...overrides
});

export const makeEndpoint = (overrides?: Partial<ApiEndpoint>): ApiEndpoint => ({
  id: 'GET::/users',
  method: 'GET',
  path: '/users',
  source: 'express',
  pathParams: [],
  queryParams: [],
  responses: [{ status: '200', description: 'OK', contentType: 'application/json' }],
  auth: 'bearer',
  confidence: 0.9,
  ...overrides
});

export const makeJobState = (overrides?: Partial<JobState>): JobState => ({
  jobId: 'test-job-1',
  stage: 'idle',
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  progress: 0,
  statusText: 'Ready',
  totalEndpoints: 0,
  completedBatches: 0,
  totalBatches: 0,
  endpoints: [],
  generatedTests: [],
  ...overrides
});

export const makeGeneratedTestCase = (overrides?: Partial<GeneratedTestCase>): GeneratedTestCase => ({
  endpointId: 'GET::/users',
  category: 'positive',
  title: 'GET /users returns 200 with user list',
  request: {
    method: 'GET',
    path: '/users',
    headers: { Authorization: 'Bearer {{API_TOKEN}}' }
  },
  expected: {
    status: 200,
    contains: [],
    contractChecks: ['response matches documented schema']
  },
  ...overrides
});

export const makeAppState = (overrides?: Partial<AppState>): AppState => ({
  contextId: 'global',
  settings: makeSettings(),
  activeJob: null,
  jobHistory: [],
  artifacts: [],
  metricsHistory: [],
  ...overrides
});

export const makeRunMetric = (overrides?: Partial<RunMetric>): RunMetric => ({
  jobId: 'test-job-1',
  status: 'complete',
  provider: 'openai',
  framework: 'jest',
  repo: 'acme/test-api',
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_060_000,
  totalMs: 60_000,
  endpointsDetected: 1,
  testsGenerated: 4,
  coveragePercent: 100,
  ...overrides
});

export const makeValidationResult = (overrides?: Partial<ValidationResult>): ValidationResult => ({
  endpointId: 'GET::/users',
  title: 'GET /users returns 200 with user list',
  success: true,
  durationMs: 120,
  status: 200,
  failures: [],
  ...overrides
});

export const makeValidationSummary = (overrides?: Partial<ValidationSummary>): ValidationSummary => ({
  attempted: 1,
  passed: 1,
  failed: 0,
  repaired: 0,
  skipped: 0,
  lastValidatedAt: 1_700_000_000_000,
  results: [makeValidationResult()],
  ...overrides
});

export const makeGeneratedArtifact = (overrides?: Partial<GeneratedArtifact>): GeneratedArtifact => ({
  id: 'artifact-1',
  createdAt: 1_700_000_000_000,
  fileName: 'APItiser_test-api_jest.zip',
  framework: 'jest',
  files: [{ path: 'tests/users.test.ts', content: 'describe("users", () => {})' }],
  zipBase64: btoa('fake-zip-content'),
  readiness: 'review_required',
  ...overrides
});
