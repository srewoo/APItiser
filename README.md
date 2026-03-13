# APItiser Chrome Extension

APItiser is a Manifest V3 Chrome extension that scans GitHub and GitLab repositories, detects API endpoints from source code and OpenAPI specs, generates comprehensive test suites using LLMs, validates them against a live API, and delivers a downloadable ZIP artifact.

## Features

### Core Pipeline

- **Repository Scanning** — Scans GitHub and GitLab repos (public and private) via their APIs. Supports configurable GitLab base URL for self-hosted instances.
- **API Detection** — Detects endpoints from code routes and OpenAPI 3.x documents.
- **LLM Test Generation** — Generates test specifications using OpenAI, Claude, or Gemini with automatic provider fallback.
- **Quality Gates** — Assesses generated tests for completeness, valid statuses, concrete paths, schema assertions, and security coverage. Auto-repairs issues via LLM repair loops.
- **Live Validation** — Executes generated tests against a configurable Base URL with full auth support (Bearer, API key, cookie session, OAuth2, CSRF).
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
| Spring Boot | `@GetMapping`, `@PostMapping`, etc. |
| Gin | `r.GET()`, `r.POST()`, etc. |
| OpenAPI 3.x | JSON and YAML spec files |

### Test Frameworks

- **Jest** (JavaScript/TypeScript)
- **Mocha + Chai** (JavaScript/TypeScript)
- **Pytest** (Python)

### Test Categories

- **Positive** — Happy-path tests with valid inputs
- **Negative** — Invalid inputs, missing required fields, unauthorized access
- **Edge** — Boundary values, empty states, pagination limits, optional fields
- **Security** — Auth absence/misuse, IDOR, privilege boundaries, input abuse

### Additional Features

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
│   ├── generation/
│   │   ├── coverage.ts          # Coverage summary computation
│   │   ├── executionValidator.ts # Live validation against base URL
│   │   ├── postmanExport.ts     # Postman collection builder
│   │   ├── readiness.ts         # Readiness assessment engine
│   │   ├── testGenerator.ts     # Batch generation, quality gates, repair
│   │   ├── zipBuilder.ts        # ZIP artifact creation
│   │   └── frameworks/          # Jest, Mocha, Pytest renderers
│   ├── llm/
│   │   ├── client.ts            # Provider adapter loader
│   │   ├── openai.ts            # OpenAI adapter
│   │   ├── claude.ts            # Claude adapter
│   │   ├── gemini.ts            # Gemini adapter
│   │   ├── promptBuilder.ts     # Prompt construction and output parsing
│   │   ├── endpointUtils.ts     # Sample values and path builders
│   │   └── fetchWithTimeout.ts  # Fetch with soft/hard timeouts + heartbeat
│   ├── parser/
│   │   ├── apiParser.ts         # Top-level parser orchestrator
│   │   ├── canonicalize.ts      # Endpoint dedup, merge, trust scoring
│   │   ├── codeRouteParser.ts   # AST-based route detection
│   │   ├── endpointBuilder.ts   # Endpoint construction utilities
│   │   ├── openApiParser.ts     # OpenAPI 3.x spec parser
│   │   ├── scanInput.ts         # OpenAPI fallback merger
│   │   └── testCoverageDetector.ts # Existing test detection
│   ├── repo/
│   │   ├── github.ts            # GitHub tree/blob/contents API
│   │   ├── gitlab.ts            # GitLab tree/file API
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
│   └── components/
│       ├── ActionFooter.tsx     # Action buttons (scan/generate/download/etc.)
│       ├── CoveragePanel.tsx    # Coverage and performance display
│       ├── EndpointList.tsx     # Endpoint selection with method filter
│       ├── ProgressTimeline.tsx # Job progress and quality status
│       ├── SettingsModal.tsx    # Full settings modal
│       └── TestPreviewModal.tsx # Generated test preview
├── sidepanel/
│   └── main.tsx                 # Side panel entry (reuses popup App)
├── shared/
│   ├── constants.ts             # Default settings, provider models
│   ├── messages.ts              # Command/event message types
│   ├── repo.ts                  # URL-to-repo parser
│   └── types.ts                 # All TypeScript interfaces and types
└── styles/
    ├── popup.css                # Popup/side panel styles
    └── sidepanel.css            # Side panel overrides
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
   - LLM provider, model, and API key.
   - Test framework (Jest, Mocha, Pytest).
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

The test suite includes 24 test files with 100 tests covering:

- **Unit** — Parsers (API, OpenAPI, code routes), LLM adapters (OpenAI, Claude, Gemini), prompt builder, test generator, normalizer, quality assessor, execution validator, readiness, coverage, retry, utilities, framework renderers, repo scanner, and validator.
- **Integration** — State manager persistence and generation progress flow.
- **Benchmarks** — Gold-standard test quality benchmarks.

## Notes

- Detection is static/heuristic-based for code routes. Unusual metaprogramming patterns may require the OpenAPI Fallback.
- API keys and tokens are stored in `chrome.storage.local` on the user machine and are never sent to any APItiser server.
- Settings export automatically excludes all sensitive values (API keys, tokens, runtime credentials, setup flows).
