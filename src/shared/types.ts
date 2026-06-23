export type HostPlatform = 'github' | 'gitlab';

export type LLMProvider = 'openai' | 'claude' | 'gemini';

export type TestFramework =
  | 'jest'
  | 'pytest'
  | 'mocha'
  | 'supertest'
  | 'gotest'
  | 'restassured'
  | 'vitest'
  | 'playwright';

export type TestCategory = 'positive' | 'negative' | 'edge' | 'security';

export type PromptMode = 'generate' | 'repair';

export type QualitySeverity = 'warn' | 'error';

export type JobQualityStatus = 'pending' | 'passed' | 'partial' | 'failed';

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
  | 'django'
  | 'spring'
  | 'jaxrs'
  | 'gin'
  | 'chi'
  | 'echo'
  | 'mux'
  | 'nethttp';

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

export interface SchemaConstraints {
  /** Allowed values (OpenAPI `enum`). A value outside this set is invalid. */
  enum?: unknown[];
  /** Inclusive numeric bounds. */
  minimum?: number;
  maximum?: number;
  /** String length bounds. */
  minLength?: number;
  maxLength?: number;
  /** RegExp source (OpenAPI `pattern`) the string value must match. */
  pattern?: string;
}

export interface SchemaField extends SchemaConstraints {
  name: string;
  required: boolean;
  type: string;
  format?: string;
  description?: string;
  example?: unknown;
}

export interface SchemaObject extends SchemaConstraints {
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

/**
 * Which credential set a test executes with. `primary` is the normal authenticated
 * identity; `secondary` is a second, lower-privilege/foreign identity used to prove
 * authorization boundaries (IDOR); `none` deliberately sends no auth.
 */
export type RequestIdentity = 'primary' | 'secondary' | 'none';

export type BodyAssertionOp =
  | 'equals'
  | 'contains'
  | 'exists'
  | 'absent'
  | 'type'
  | 'matches'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'in'
  | 'length';

/**
 * A machine-checkable assertion against the response body. `path` is a dot/bracket JSON
 * path (e.g. `data.items[0].id`); an empty path targets the whole body. These replace the
 * old free-text `contractChecks` as the *executable* contract — they are asserted by live
 * validation and rendered as real assertions in every framework.
 */
export interface BodyAssertion {
  path: string;
  op: BodyAssertionOp;
  /** Comparison value (for equals/contains/matches/gt/lt/in/type/length). */
  value?: unknown;
  /** Optional human description of the invariant, surfaced as a code comment. */
  description?: string;
}

/** Whether an assertion field was supplied by the model or filled by the normalizer. */
export interface AssertionProvenance {
  schemaFromModel: boolean;
  contractFromModel: boolean;
  bodyAssertionsFromModel: boolean;
}

export interface GeneratedTestCase {
  endpointId: string;
  category: TestCategory;
  title: string;
  rationale?: string;
  trustScore?: number;
  trustLabel?: TrustLabel;
  /** Ordering hint for lifecycle sequencing (setup/create < use < teardown). Lower runs first. */
  order?: number;
  /** True when this test creates a resource other tests depend on. */
  isSetup?: boolean;
  /** True when this test tears down a resource created earlier in the suite. */
  isTeardown?: boolean;
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    /** Identity to execute with. Defaults to `primary` when omitted. */
    identity?: RequestIdentity;
  };
  expected: {
    status: number;
    contains?: string[];
    contentType?: string;
    responseHeaders?: Record<string, string>;
    jsonSchema?: SchemaObject;
    /** Free-text human notes only. NOT executed — see `bodyAssertions` for the real contract. */
    contractChecks?: string[];
    /** Executable, field-level response assertions. */
    bodyAssertions?: BodyAssertion[];
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
  /**
   * Sampling temperature for classic (non-reasoning) models. Ignored for reasoning models
   * (OpenAI o-series/gpt-5, Claude 4.x, …) which reject the parameter — see modelCapabilities.
   */
  temperature?: number;
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
  /**
   * Secondary identity credentials. A second, lower-privilege/foreign user used to prove
   * authorization boundaries (IDOR): the suite requests another identity's resource with
   * these credentials and asserts it is denied. When absent, IDOR tests downgrade to an
   * unauthenticated check.
   */
  runtimeSecondaryApiToken?: string;
  runtimeSecondaryApiKey?: string;
  runtimeSecondarySessionCookie?: string;
  /** Auth mode used when executing live validation flows */
  runtimeAuthMode?: RuntimeAuthMode;
  /** Retry transient 429/5xx responses during live validation (and in generated suites). */
  retryOnRateLimit?: boolean;
  /** Maximum retry attempts for transient responses. Defaults to 2. */
  maxRetries?: number;
  /**
   * Local-runner integration. When enabled, "Run locally" asks the native messaging host to
   * boot the repo's service via runLocal, then validates the generated suite against it.
   * Requires the one-time native host install (see native-host/INSTALL.md).
   */
  enableLocalRunner?: boolean;
  /** Native messaging host name. Defaults to com.apitiser.localrunner. */
  localRunnerHostName?: string;
  /** Absolute path to the repo on disk that the host should boot. */
  localRepoPath?: string;
  /** Port the local service should listen on (also the validation base URL port). */
  localRunPort?: number;
  /** Absolute path to runLocal's run-local.sh (host falls back to its bundled copy). */
  runLocalScriptPath?: string;
  /** Optional run-command / stack overrides forwarded to runLocal. */
  localRunCmd?: string;
  localRunStack?: string;
  /** Command used to run the repo's OWN existing tests (auto-detected when blank). */
  localTestCommand?: string;
  /** Max time to allow for install + boot. Defaults to 180000ms. */
  localRunBootTimeoutMs?: number;
  /** Optional explicit setup/login flow executed before live validation */
  runtimeSetupSteps?: RuntimeSetupStep[];
  /**
   * Named runtime values (e.g. { USER_ID: "42" }) used to resolve `{{NAME}}` placeholders
   * in generated test paths/queries/bodies during live validation. Setup steps can also
   * populate these via `extractValues`. Generated test files surface the same names as
   * environment variables so a real id can be injected without editing each test.
   */
  runtimeValues?: Record<string, string>;
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
    | 'weak-assertions'
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
  /**
   * Capture arbitrary named runtime values from this step's JSON response, keyed by the
   * placeholder name used in test paths/bodies (e.g. { USER_ID: "data.id" }). Enables
   * resource chaining: create a resource here, then reference its id as {{USER_ID}}.
   */
  extractValues?: Record<string, string>;
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
  /** Framework suggested from the detected route sources (advisory; does not override settings). */
  suggestedFramework?: TestFramework;
  /**
   * Result of the last LOCAL test run via the native runner — either the APItiser-generated
   * suite (`generated`) or the repo's own existing tests (`repo`). Exit code 0 = passed.
   */
  localTestRun?: {
    kind: 'generated' | 'repo';
    exitCode: number;
    passed: boolean;
    command?: string;
    durationMs?: number;
    ranAt: number;
  };
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
  /** Sampling temperature; omitted automatically for reasoning models by each adapter. */
  temperature?: number;
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
