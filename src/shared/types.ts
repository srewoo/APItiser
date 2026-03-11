export type HostPlatform = 'github' | 'gitlab';

export type LLMProvider = 'openai' | 'claude' | 'gemini';

export type TestFramework = 'jest' | 'pytest' | 'mocha';

export type TestCategory = 'positive' | 'negative' | 'edge' | 'security';

export type PromptMode = 'generate' | 'repair';

export type QualitySeverity = 'warn' | 'error';

export type JobQualityStatus = 'pending' | 'passed' | 'failed';

export type ReadinessState = 'scaffold' | 'review_required' | 'validated' | 'production_candidate';

export type EndpointSource =
  | 'express'
  | 'fastify'
  | 'nestjs'
  | 'openapi'
  | 'koa'
  | 'hono'
  | 'nextjs'
  | 'fastapi'
  | 'flask'
  | 'spring'
  | 'gin';

export type AuthType = 'bearer' | 'apiKey' | 'cookieSession' | 'oauth2' | 'csrf' | 'none' | 'unknown';

export type TrustLabel = 'high' | 'medium' | 'heuristic';

export type RuntimeAuthMode = 'none' | 'bearer' | 'apiKey' | 'cookieSession' | 'oauth2';

export type JobStage =
  | 'idle'
  | 'scanning'
  | 'parsing'
  | 'generating'
  | 'validating'
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
  source: EndpointSource;
  filePath?: string;
  operationId?: string;
  summary?: string;
  description?: string;
  auth?: AuthType;
  confidence?: number;
  evidence?: EndpointEvidence[];
  pathParams: SchemaField[];
  queryParams: SchemaField[];
  body?: SchemaObject;
  responses: EndpointResponse[];
  authHints?: AuthHint[];
  examples?: EndpointExample[];
  sourceMetadata?: EndpointSourceMetadata;
  trustScore?: number;
  trustLabel?: TrustLabel;
  tags?: string[];
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
  example?: unknown;
}

export interface SchemaObject {
  type: string;
  required?: string[];
  properties?: Record<string, SchemaObject | SchemaField>;
  items?: SchemaObject;
  description?: string;
  example?: unknown;
}

export interface EndpointResponse {
  status: string;
  description?: string;
  contentType?: string;
  schema?: SchemaObject;
}

export interface AuthHint {
  type: AuthType;
  headerName?: string;
  queryParamName?: string;
  cookieName?: string;
  csrfHeaderName?: string;
  setupSteps?: string[];
  confidence?: number;
  evidence?: string;
}

export interface EndpointExample {
  origin: 'openapi' | 'code' | 'existing-test' | 'inferred';
  request?: {
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    cookies?: Record<string, string>;
  };
  response?: {
    status?: number;
    bodySnippet?: string;
  };
  note?: string;
}

export interface EndpointSourceMetadata {
  sources: EndpointSource[];
  hasExistingTests: boolean;
  mergedFromOpenApi: boolean;
  mergedFromCode: boolean;
  inferredFromExamples: boolean;
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
  rationale?: string;
  trustScore?: number;
  trustLabel?: TrustLabel;
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
    contentType?: string;
    responseHeaders?: Record<string, string>;
    jsonSchema?: SchemaObject;
    contractChecks?: string[];
    pagination?: boolean;
    idempotent?: boolean;
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
  readiness?: ReadinessState;
  readinessNotes?: string[];
  validationSummary?: ValidationSummary;
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
  /** Base URL injected into generated test files (e.g. http://localhost:3000) */
  baseUrl?: string;
  /** Custom instructions appended to the LLM prompt */
  customPromptInstructions?: string;
  /** Whether to auto-fallback to the next configured provider on error */
  enableProviderFallback?: boolean;
  /** Execute generated tests against baseUrl before packaging */
  validateGeneratedTests?: boolean;
  /** Attempt LLM repair for tests that fail live validation */
  autoRepairFailingTests?: boolean;
  /** Maximum validation repair rounds */
  maxValidationRepairs?: number;
  /** Optional session cookie name used during live validation */
  sessionCookieName?: string;
  /** Optional CSRF header name used during live validation */
  csrfHeaderName?: string;
  /** Optional API key header name used during live validation */
  apiKeyHeaderName?: string;
  /** Runtime bearer/OAuth token used for live validation */
  runtimeApiToken?: string;
  /** Runtime API key value used for live validation */
  runtimeApiKey?: string;
  /** Runtime CSRF token used for live validation */
  runtimeCsrfToken?: string;
  /** Runtime session cookie value used for live validation */
  runtimeSessionCookie?: string;
  /** Auth mode used when executing live validation flows */
  runtimeAuthMode?: RuntimeAuthMode;
  /** Optional explicit setup/login flow executed before live validation */
  runtimeSetupSteps?: RuntimeSetupStep[];
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
    | 'provider-output'
    | 'schema-assertion'
    | 'contract-assertion'
    | 'execution-status'
    | 'execution-body'
    | 'execution-auth';
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

export interface ValidationFailure {
  type: 'status' | 'contains' | 'schema' | 'header' | 'network' | 'contract' | 'auth' | 'pagination' | 'idempotency';
  message: string;
  expected?: string;
  actual?: string;
}

export interface RuntimeSetupStep {
  id: string;
  name: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  expectedStatus?: number;
  extractJsonPaths?: Partial<Record<'apiToken' | 'apiKey' | 'csrfToken' | 'sessionCookie', string>>;
  extractHeaders?: Partial<Record<'apiToken' | 'apiKey' | 'csrfToken' | 'sessionCookie', string>>;
  extractCookieName?: string;
}

export interface ValidationSetupStepResult {
  id: string;
  name: string;
  success: boolean;
  durationMs: number;
  status?: number;
  extracted: string[];
  message?: string;
  responseSnippet?: string;
}

export interface ValidationResult {
  endpointId: string;
  title: string;
  success: boolean;
  durationMs: number;
  status?: number;
  failures: ValidationFailure[];
  responseSnippet?: string;
}

export interface ValidationSummary {
  attempted: number;
  passed: number;
  failed: number;
  repaired: number;
  skipped: number;
  lastValidatedAt: number;
  results: ValidationResult[];
  warnings?: string[];
  notRunReason?: string;
  setupSteps?: ValidationSetupStepResult[];
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
  validationSummary?: ValidationSummary;
  readiness?: ReadinessState;
  readinessNotes?: string[];
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
  customPromptInstructions?: string;
  baseUrl?: string;
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
  readiness?: ReadinessState;
  readinessNotes?: string[];
  validationSummary?: ValidationSummary;
}
