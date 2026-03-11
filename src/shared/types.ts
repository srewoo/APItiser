export type HostPlatform = 'github' | 'gitlab';

export type LLMProvider = 'openai' | 'claude' | 'gemini';

export type TestFramework = 'jest' | 'pytest' | 'mocha';

export type TestCategory = 'positive' | 'negative' | 'edge' | 'security';

export type PromptMode = 'generate' | 'repair';

export type QualitySeverity = 'warn' | 'error';

export type JobQualityStatus = 'pending' | 'passed' | 'failed';

export type JobStage =
  | 'idle'
  | 'scanning'
  | 'parsing'
  | 'generating'
  | 'packaging'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface RepoRef {
  platform: HostPlatform;
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  gitlabBaseUrl?: string;
}

export interface RepoFile {
  path: string;
  content: string;
  sha?: string;
  size?: number;
}

export interface ApiEndpoint {
  id: string;
  method: string;
  path: string;
  source: 'express' | 'fastify' | 'nestjs' | 'openapi' | 'koa' | 'hono' | 'nextjs' | 'fastapi' | 'flask';
  filePath?: string;
  operationId?: string;
  summary?: string;
  description?: string;
  auth?: 'bearer' | 'apiKey' | 'none' | 'unknown';
  confidence?: number;
  evidence?: EndpointEvidence[];
  pathParams: SchemaField[];
  queryParams: SchemaField[];
  body?: SchemaObject;
  responses: EndpointResponse[];
}

export interface EndpointEvidence {
  filePath: string;
  line?: number;
  snippet?: string;
  reason: string;
}

export interface SchemaField {
  name: string;
  required: boolean;
  type: string;
  format?: string;
  description?: string;
}

export interface SchemaObject {
  type: string;
  required?: string[];
  properties?: Record<string, SchemaObject | SchemaField>;
  items?: SchemaObject;
  description?: string;
}

export interface EndpointResponse {
  status: string;
  description?: string;
}

export interface CoverageSummary {
  endpointsDetected: number;
  testsGenerated: number;
  coveragePercent: number;
  gaps: string[];
}

export interface RepoValidationCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface RepoValidationResult {
  ok: boolean;
  checkedAt: number;
  checks: RepoValidationCheck[];
}

export interface GeneratedTestCase {
  endpointId: string;
  category: TestCategory;
  title: string;
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  };
  expected: {
    status: number;
    contains?: string[];
  };
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedArtifact {
  id: string;
  createdAt: number;
  fileName: string;
  framework: TestFramework;
  files: GeneratedFile[];
  zipBase64: string;
}

export interface ExtensionSettings {
  provider: LLMProvider;
  model: string;
  framework: TestFramework;
  includeCategories: TestCategory[];
  testDirectories: string[];
  skipExistingTests: boolean;
  openApiFallbackSpec?: string;
  openAiKey?: string;
  claudeKey?: string;
  geminiKey?: string;
  githubToken?: string;
  gitlabToken?: string;
  gitlabBaseUrl?: string;
  batchSize: number;
  timeoutMs: number;
}

export interface JobTimings {
  scanStartedAt?: number;
  scanCompletedAt?: number;
  generationStartedAt?: number;
  generationCompletedAt?: number;
}

export interface QualityIssue {
  code:
    | 'missing-endpoint-tests'
    | 'missing-category'
    | 'unresolved-path'
    | 'invalid-status'
    | 'generic-title'
    | 'weak-security'
    | 'provider-output';
  message: string;
  severity: QualitySeverity;
  endpointId?: string;
  category?: TestCategory;
}

export interface BatchQualityAssessment {
  passed: boolean;
  issues: QualityIssue[];
}

export interface BatchGenerationDiagnostics {
  batchIndex: number;
  endpointIds: string[];
  provider: LLMProvider;
  repairAttempted: boolean;
  assessment: BatchQualityAssessment;
}

export interface RunMetric {
  jobId: string;
  status: 'complete' | 'error' | 'cancelled';
  provider?: LLMProvider;
  framework?: TestFramework;
  repo?: string;
  startedAt: number;
  completedAt: number;
  scanMs?: number;
  generationMs?: number;
  totalMs: number;
  endpointsDetected: number;
  testsGenerated: number;
  coveragePercent?: number;
}

export interface JobState {
  jobId: string;
  stage: JobStage;
  startedAt: number;
  updatedAt: number;
  repo?: RepoRef;
  progress: number;
  statusText: string;
  totalEndpoints: number;
  completedBatches: number;
  totalBatches: number;
  endpoints: ApiEndpoint[];
  generatedTests: GeneratedTestCase[];
  existingTestEndpointIds?: string[];
  eligibleEndpointCount?: number;
  queuedEndpointIds?: string[];
  resumedFromCheckpoint?: boolean;
  timings?: JobTimings;
  coverage?: CoverageSummary;
  batchDiagnostics?: BatchGenerationDiagnostics[];
  qualityStatus?: JobQualityStatus;
  repairAttempts?: number;
  artifactId?: string;
  error?: string;
  activeProvider?: LLMProvider;
}

export interface AppState {
  contextId?: string;
  settings: ExtensionSettings;
  activeJob: JobState | null;
  jobHistory: JobState[];
  artifacts: GeneratedArtifact[];
  metricsHistory: RunMetric[];
  lastValidation?: RepoValidationResult;
}

export interface ScanResult {
  files: RepoFile[];
  endpointMap: ApiEndpoint[];
}

export interface ProviderResult {
  tests: GeneratedTestCase[];
  rawText?: string;
}

export interface GenerateContext {
  repo: RepoRef;
  framework: TestFramework;
  includeCategories: TestCategory[];
  timeoutMs: number;
}

export interface LLMProviderAdapter {
  readonly provider: LLMProvider;
  generateTests(
    batch: ApiEndpoint[],
    context: GenerateContext,
    options: ProviderOptions
  ): Promise<ProviderResult>;
}

export interface ProviderOptions {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  timeoutMs: number;
  hardTimeoutMs?: number;
  heartbeatMs?: number;
  onHeartbeat?: (elapsedMs: number) => void | Promise<void>;
  promptMode?: PromptMode;
  repairIssues?: QualityIssue[];
  currentTests?: GeneratedTestCase[];
  promptOverride?: string;
}

export interface TestFrameworkAdapter {
  readonly framework: TestFramework;
  render(tests: GeneratedTestCase[], projectMeta: ProjectMeta): GeneratedFile[];
  renderReadme(projectMeta: ProjectMeta): GeneratedFile;
  renderSupportFiles?(projectMeta: ProjectMeta): GeneratedFile[];
}

export interface ProjectMeta {
  repo: RepoRef;
  generatedAt: string;
  framework: TestFramework;
  endpointCount: number;
}
