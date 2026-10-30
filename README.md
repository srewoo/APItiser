# APItiser Chrome Extension

APItiser is a Manifest V3 Chrome extension that scans GitHub and GitLab repositories, detects API endpoints from source code and OpenAPI specs, generates comprehensive test suites using LLMs, validates them against a live API, and delivers a downloadable ZIP artifact.

## Features

### Core Pipeline

- **Repository Scanning** — Scans GitHub and GitLab repos (public and private) via their APIs. Supports configurable GitLab base URL for self-hosted instances.
- **API Detection** — Detects endpoints from code routes and OpenAPI 3.x documents.
- **LLM Test Generation** — Generates test specifications using OpenAI, Claude, or Gemini with automatic provider fallback. Supports reasoning ("thinking") models (temperature omitted automatically) and any OpenAI-compatible server (configurable base URL — e.g. local Ollama/LM Studio/vLLM).
- **Deterministic Test Synthesis** — Beyond the LLM pass, APItiser deterministically synthesizes schema-driven negative and edge cases, security cases (IDOR, injection, auth-boundary), and resource-lifecycle ordering (create → use → teardown) so suites cover cases the model may miss.
- **Framework Auto-Suggestion** — Suggests a test framework from the detected route sources (advisory; never overrides your setting).
- **Local Runner** — An optional native-messaging host boots the target repo locally (via `runLocal`) and validates the generated suite against `localhost` — no need to start the service by hand. See [`native-host/INSTALL.md`](native-host/INSTALL.md) and [`docs/adr/0001-local-runner-native-messaging.md`](docs/adr/0001-local-runner-native-messaging.md).
- **Quality Gates** — Assesses generated tests for completeness, valid statuses, concrete paths, schema assertions, and security coverage. Auto-repairs issues via LLM repair loops.
- **Live Validation** — Executes generated tests against a configurable Base URL with full auth support (Bearer, API key, cookie session, OAuth2, CSRF). Runs with bounded concurrency (serial when the suite declares resource-lifecycle ordering) under a wall-clock budget. Route-local auth attribution and a visual setup-step editor (login/token-exchange flows) are built in.
- **Run in Browser** — Run the generated tests for one endpoint (▶ on its row) or all of them against your local API and see per-test results live in the panel: pass/fail, status, timing, failure reasons, and the response body. Start the API with the local runner (it stays up between runs, with a Start/Stop control), or start it yourself — the panel suggests the command for your stack and checks the server is reachable.
- **Local-only safety** — Live tests send POST/PUT/DELETE and attack-style requests, so they only run against `localhost`/`127.0.0.1` unless you explicitly allow non-local URLs in Settings.
- **Local LLMs** — One click to use Ollama or LM Studio (any OpenAI-compatible server on localhost). No API key needed; code never leaves your machine.
- **Live model lists** — The model picker lists the models your key (or local server) actually has. Temperature is omitted automatically for reasoning models, and an unrecognised model that rejects `temperature`/`max_tokens` is retried without it.
- **Cost & Token Tracking** — Per-run input/output token totals and an advisory USD cost estimate; Claude calls use prompt caching on the shared system prompt.
- **Auto-Repair** — Tests that fail live validation are automatically sent back to the LLM for correction (configurable repair rounds).
- **Readiness Assessment** — Labels each artifact as `production_candidate`, `validated`, `review_required`, or `scaffold`.
- **Artifact Packaging** — Bundles generated test files, README, `.env.example`, and validation report into a downloadable ZIP.

### Supported Route Detection Sources

| Language/Framework | Detection Method |
|---|---|
| Express | `app.get()`, `router.post()`, etc. |
| Fastify | `fastify.get()`, route declarations |
| NestJS | `@Controller` + `@Get/@Post/@Put/@Delete` decorators |
| Koa | `router.get()`, route definitions |
| Hono | `app.get()`, route declarations |
| Next.js | API route file conventions |
| FastAPI | `@app.get()` / `@router.post()` decorators |
| Flask | `@app.route()` / `@blueprint.route()` decorators |
| Django / DRF | `path()` / `re_path()` URLconf and DRF routers |
| Spring Boot | `@GetMapping`, `@PostMapping`, etc. |
| JAX-RS | `@Path` + `@GET/@POST/@PUT/@DELETE` |
| Gin | `r.GET()`, `r.POST()`, etc. |
| chi | `r.Get()`, `r.Post()`, etc. |
| Echo | `e.GET()`, `e.POST()`, etc. |
| gorilla/mux | `r.HandleFunc(...).Methods(...)` |
| net/http (1.22+) | Method-prefixed patterns (`mux.HandleFunc("GET /path", …)`) |
| Rails | `config/routes.rb` DSL — verbs, `resources`, `namespace`/`scope` prefixes |
| Laravel (PHP) | `Route::get()`, `Route::apiResource()`, `Route::prefix()->group()` |
| Symfony (PHP) | `#[Route(...)]` attributes and `@Route(...)` annotations (incl. class prefixes) |
| gRPC | `.proto` `service`/`rpc` definitions → gRPC-JSON/Connect `POST /pkg.Service/Method` |
| tRPC | `router({...})` procedures — `.query` → `GET /trpc/…`, `.mutation` → `POST /trpc/…` |
| OpenAPI 3.x | JSON and YAML spec files (incl. `allOf`/`oneOf`/`anyOf` composition) |
| GraphQL | SDL `type Query`/`Mutation`/`Subscription` fields (`.graphql`/`.gql` + inline `gql\`…\``) |

### Test Frameworks

Nine renderers, selected via a shared framework registry:

- **Jest** (JavaScript/TypeScript)
- **Jest + Supertest** (JavaScript/TypeScript)
- **Vitest** (JavaScript/TypeScript)
- **Mocha + Chai** (JavaScript/TypeScript)
- **Playwright (API)** (JavaScript/TypeScript)
- **Pytest** (Python)
- **JUnit 5 + REST Assured** (Java)
- **Go** (`testing`)

### Test Categories

- **Positive** — Happy-path tests with valid inputs
- **Negative** — Invalid inputs, missing required fields, unauthorized access
- **Edge** — Boundary values, empty states, pagination limits, optional fields
- **Security** — Auth absence/misuse, IDOR, privilege boundaries, input abuse

### Additional Features

- **Guided Onboarding** — A first-run wizard opens automatically on install: add and live-test an AI provider key, optionally add GitHub/GitLab tokens for private repos, and learn how to generate your first suite. Re-openable anytime from the popup's setup checklist.
- **Endpoint Selection** — Select/deselect individual endpoints before generation. Filter by HTTP method.
- **Existing Test Detection** — Detects existing tests in configurable directories. Optionally skips already-covered endpoints.
- **OpenAPI Fallback** — Paste or import a spec for endpoints that cannot be detected from source code.
- **Test Preview** — Inspect all generated test cases before downloading.
- **Postman Export** — Download a Postman collection JSON from generated tests.
- **Settings Import/Export** — Back up and restore settings (secrets are excluded from exports).
- **Coverage Summary** — Endpoints detected, tests generated, coverage percentage, and gaps.
- **Run Metrics** — Timing breakdowns (scan, generation, total), provider used, and historical metrics.
- **Auto-Resume** — Checkpoints scan, generation, and packaging progress. Resumes automatically after service worker restart.
- **Per-Page Context** — Isolates state by browser tab and URL. Each page has independent jobs, history, and artifacts.
- **Notifications** — Chrome notifications on scan/generation completion and errors.
- **Validation Setup Flow** — Configure login, token exchange, or fixture creation steps that run before live validation.
- **Custom Prompt Instructions** — Append free-text instructions to LLM prompts for project-specific requirements.
- **Provider Fallback** — Auto-fallback to the next configured LLM provider on failure.

## Tech Stack

- **UI** — React 18 + TypeScript
- **Build** — Vite 5 with multi-entry build and manual chunking
- **Extension** — Chrome Manifest V3 with service worker
- **Parsing** — Babel parser/traverse for AST-based route detection, `yaml` for OpenAPI
- **Packaging** — JSZip for artifact ZIP creation
- **Testing** — Vitest with unit, integration, and benchmark suites
- **Linting** — ESLint (flat config) + Prettier

## Project Structure

```
src/
├── background/
│   ├── service-worker.ts        # Message handling, orchestration, resume logic
│   ├── core/
│   │   ├── badge.ts             # Extension badge updates
│   │   ├── emitter.ts           # Runtime message broadcasting
│   │   ├── keepAlive.ts         # Service worker keep-alive via alarms
│   │   ├── notifier.ts          # Chrome notification dispatch
│   │   └── stateManager.ts      # Persistent state (chrome.storage.local)
│   ├── runner/
│   │   ├── localRunner.ts       # Native-messaging client: boot repo + run suite locally
│   │   ├── runnerPackage.ts     # Builds the downloadable local-runner bundle
│   │   └── suiteCommands.ts     # Per-framework run commands for the local runner
│   ├── generation/
│   │   ├── coverage.ts          # Coverage summary computation
│   │   ├── executionValidator.ts # Live validation against base URL ({{NAME}} resolution)
│   │   ├── frameworkSuggest.ts  # Framework auto-suggestion from route sources
│   │   ├── postmanExport.ts     # Postman collection builder
│   │   ├── qualityGate.ts       # Quality assessment + generated-test normalizer
│   │   ├── readiness.ts         # Readiness assessment engine
│   │   ├── resourceLifecycle.ts # Deterministic create → use → teardown ordering
│   │   ├── securityCases.ts     # Deterministic IDOR/injection/auth-boundary cases
│   │   ├── statusExpectation.ts # Expected-status inference
│   │   ├── syntheticCases.ts    # Schema-driven negative/edge case synthesis
│   │   ├── testGenerator.ts     # Batch generation, quality gates, repair
│   │   ├── zipBuilder.ts        # ZIP artifact creation
│   │   └── frameworks/          # 9 renderers + shared helpers
│   │       ├── registry.ts      # Framework → renderer registry
│   │       ├── jest.ts / vitest.ts / mocha.ts / supertest.ts / playwright.ts
│   │       ├── pytest.ts / restassured.ts / gotest.ts
│   │       └── assertions.ts / pathing.ts / runtimeTokens.ts  # shared render helpers
│   ├── llm/
│   │   ├── client.ts            # Provider adapter loader
│   │   ├── openai.ts            # OpenAI adapter (configurable base URL)
│   │   ├── claude.ts            # Claude adapter
│   │   ├── gemini.ts            # Gemini adapter
│   │   ├── modelCapabilities.ts # Reasoning-model detection, temperature/token-field rules
│   │   ├── promptBuilder.ts     # Prompt construction and output parsing
│   │   ├── endpointUtils.ts     # Sample values and path builders
│   │   └── fetchWithTimeout.ts  # Fetch with soft/hard timeouts + heartbeat
│   ├── parser/
│   │   ├── apiParser.ts         # Top-level parser orchestrator
│   │   ├── authConsolidation.ts # Merge/normalize auth hints across sources
│   │   ├── canonicalize.ts      # Endpoint dedup, merge, trust scoring
│   │   ├── codeRouteParser.ts   # AST-based route detection (JS/TS)
│   │   ├── endpointBuilder.ts   # Endpoint construction utilities
│   │   ├── openApiParser.ts     # OpenAPI 3.x spec parser
│   │   ├── routeTypes.ts        # Route-detection shared types
│   │   ├── scanInput.ts         # OpenAPI fallback merger
│   │   ├── testCoverageDetector.ts # Existing test detection
│   │   └── languages/           # Non-JS route detectors
│   │       ├── python.ts        # FastAPI, Flask, Django/DRF
│   │       ├── java.ts          # Spring Boot, JAX-RS
│   │       └── go.ts            # Gin, chi, Echo, gorilla/mux, net/http 1.22
│   ├── repo/
│   │   ├── github.ts            # GitHub tree/blob/contents API
│   │   ├── gitlab.ts            # GitLab tree/file API (configurable base URL)
│   │   ├── rateLimit.ts         # Rate limit detection and backoff
│   │   ├── scanner.ts           # Platform-agnostic scanner entry
│   │   ├── shared.ts            # File filtering and ranking
│   │   └── validator.ts         # Repo access validation
│   └── utils/
│       ├── chunks.ts            # Array chunking
│       ├── id.ts                # ID generation
│       └── retry.ts             # Retry with exponential backoff
├── popup/
│   ├── App.tsx                  # Main React app shell
│   ├── main.tsx                 # Popup entry point
│   ├── runtime.ts               # Chrome messaging bridge
│   ├── hooks/
│   │   └── usePopupState.ts     # Popup state subscription hook
│   └── components/
│       ├── ActionFooter.tsx     # Action buttons (scan/generate/download/etc.)
│       ├── CoveragePanel.tsx    # Coverage and performance display
│       ├── EndpointList.tsx     # Endpoint selection with method filter
│       ├── ErrorBoundary.tsx    # Popup error boundary
│       ├── ProgressTimeline.tsx # Job progress and quality status
│       ├── SettingsModal.tsx    # Full settings modal
│       └── TestPreviewModal.tsx # Generated test preview
├── sidepanel/
│   └── main.tsx                 # Side panel entry (reuses popup App)
├── shared/
│   ├── constants.ts             # Default settings, provider models, base URLs
│   ├── messages.ts              # Command/event message types
│   ├── repo.ts                  # URL-to-repo parser
│   ├── types.ts                 # All TypeScript interfaces and types
│   ├── platform/                # Chrome-platform abstraction + test doubles
│   ├── generated/               # Build-time generated local-runner bundle
│   └── testing/                 # Shared test factories
└── styles/
    ├── popup.css                # Popup/side panel styles
    └── sidepanel.css            # Side panel overrides
```

Supporting directories at the repo root:

```
native-host/                     # Native-messaging host: installer + runLocal launcher
├── INSTALL.md                   # One-time local-runner install + trust model
├── apitiser-runner.mjs          # The host process
├── com.apitiser.localrunner.json.template
├── install.sh / install.ps1     # macOS/Linux and Windows registration
docs/adr/
└── 0001-local-runner-native-messaging.md  # ADR for the local-runner design
```

## Scripts

```bash
npm install          # Install dependencies
npm run build        # Type-check and build into dist/
npm run build:webstore  # Build + create apitiser-chrome-webstore.zip
npm run dev          # Start Vite dev server
npm run preview      # Preview built output
npm test             # Run all tests once
npm run test:watch   # Run tests in watch mode
npm run benchmark    # Run benchmark suite
npm run lint         # Run ESLint on src/ and tests/
npm run lint:fix     # Run ESLint with auto-fix
npm run format       # Format with Prettier
npm run format:check # Check formatting without writing
```

## Load in Chrome

1. Run `npm install && npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `dist` directory inside the project root.
6. Navigate to a GitHub or GitLab repository page.
7. Click the APItiser toolbar icon to open the side panel.

## Usage Flow

1. Open a GitHub or GitLab repository page in the active tab.
2. Open APItiser from the toolbar icon.
3. In **Settings**, configure:
   - LLM provider, model, and API key. (For OpenAI-compatible/local servers, set the OpenAI Base URL.)
   - Test framework (Jest, Jest+Supertest, Vitest, Mocha, Playwright, Pytest, REST Assured, Go).
   - Categories to generate (positive, negative, edge, security).
   - Base URL for live validation (optional).
   - GitHub/GitLab tokens for private repos (optional).
4. Click **Validate Access** to verify token scopes (recommended for private repos).
5. Click **Scan Repo** to detect API endpoints.
6. Review detected endpoints. Select/deselect as needed. Filter by HTTP method.
7. Click **Generate Tests** to start LLM generation with quality gates.
8. (Optional) If live validation is enabled, tests are validated and auto-repaired.
9. Review the readiness assessment and quality diagnostics.
10. Click **Preview Tests** to inspect generated tests before downloading.
11. Click **Download Tests** to save the ZIP artifact.
12. (Optional) Click **Export Postman** to download a Postman collection.
13. Use **Clear** to reset the current page context when done.

## Architecture Highlights

- **Service Worker Orchestration** — All background work runs in a Manifest V3 service worker with keep-alive alarms, abort controllers, and checkpoint/resume for long-running operations.
- **Multi-Context State** — State is isolated per browser tab + URL path. Each context has independent jobs, history, artifacts, and metrics, all persisted to `chrome.storage.local`.
- **Quality Gate Pipeline** — Generated tests pass through quality assessment (missing tests, invalid statuses, unresolved paths, generic titles, weak security coverage). Failed batches trigger LLM repair loops (up to 3 attempts).
- **Safe Repair Merging** — Repair replacements are constrained: they must maintain the same endpoint, category, method, and assertion strength. Regressions are rejected.
- **Live Execution Validator** — Tests are executed against the configured Base URL with full auth support. Schema validation, content-type checks, contract assertions, pagination, and idempotency are verified.
- **Rate Limit Handling** — GitHub and GitLab rate limit headers are checked after each batch. When limits are exhausted, the scanner sleeps until the reset window.
- **Content Security Policy** — Extension pages enforce `script-src 'self'; object-src 'self'`.

## Testing

The test suite includes 61 test files with 522 tests covering:

- **Unit** — Parsers (API, OpenAPI, code routes, per-language detectors), auth consolidation, LLM adapters (OpenAI, Claude, Gemini) and model-capability rules, prompt builder, test generator, normalizer, quality gate, deterministic synthesis (synthetic/security/lifecycle cases), execution validator, readiness, coverage, framework auto-suggestion, retry, utilities, all nine framework renderers, Postman export, repo scanner (GitHub/GitLab), validator, and the local runner.
- **Integration** — State manager persistence and generation progress flow.
- **Benchmarks** — Gold-standard test quality benchmarks (`npm run benchmark`).

Run against a fresh checkout with `npm test` (≈6s).

## Notes

- Detection is static/heuristic-based for code routes. Unusual metaprogramming patterns may require the OpenAPI Fallback.
- API keys and tokens are stored in `chrome.storage.local` on the user machine and are never sent to any APItiser server.
- Settings export automatically excludes all sensitive values (API keys, tokens, runtime credentials, setup flows).
