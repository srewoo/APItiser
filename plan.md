# APItiser — Deep Codebase Analysis & Improvement Plan

## Executive Summary

APItiser is a Manifest V3 Chrome extension (React + TypeScript + Vite) that scans GitHub/GitLab repositories, detects API endpoints via static analysis and OpenAPI specs, generates test suites using LLMs (OpenAI/Claude/Gemini), and packages them as downloadable ZIP artifacts. The codebase is **~5,500 lines across 51 source files** with **18 test files**, well-structured and functional, but contains several areas for improvement ranging from critical bugs to code quality enhancements.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Side Panel UI                      │
│    popup/App.tsx (894 lines) — React single-file UI  │
│    popup/runtime.ts — chrome.runtime.sendMessage     │
│    popup/main.tsx — React bootstrap                  │
│    styles/popup.css — Styling                        │
└──────────────────────┬──────────────────────────────┘
                       │ chrome.runtime.sendMessage
┌──────────────────────▼──────────────────────────────┐
│              Service Worker (773 lines)               │
│  ┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Scan   │→│ Parse    │→│ Generate │→│ Package  │  │
│  │ Repo   │ │ Routes   │ │ Tests    │ │ ZIP      │  │
│  └────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                       │
│  Core: stateManager, emitter, badge, notifier,       │
│        keepAlive                                      │
└──────────────────────┬──────────────────────────────┘
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │  Repo    │ │  Parser  │ │  LLM     │
    │ Scanners │ │  Engine  │ │ Adapters │
    │ github   │ │ Babel    │ │ openai   │
    │ gitlab   │ │ AST +    │ │ claude   │
    │ validator│ │ OpenAPI  │ │ gemini   │
    └──────────┘ │ + Python │ └──────────┘
                 └──────────┘
```

**Job Lifecycle:** `idle` → `scanning` → `parsing` → `generating` → `packaging` → `complete`

**Key Features:**
- Per-tab+URL context isolation
- Checkpoint/resume after service worker restart
- Batch generation with quality assessment and auto-repair
- Endpoint selection with existing test skip
- Test framework rendering (Jest, Mocha+Chai, Pytest)
- Coverage gap analysis
- Run metrics history

---

## 🔴 Critical Issues / Bugs

### 1. `keepAlive` Listener Is a No-Op
**File:** `src/background/core/keepAlive.ts:13-19`

The `registerKeepAliveListener` registers an alarm listener but the callback body is empty — it doesn't actually do anything when the alarm fires. The alarm fires every 24 seconds but the handler is a no-op. This defeats the purpose of the keep-alive mechanism.

**Fix:** The alarm handler should perform a minimal operation (e.g., read storage, log a timestamp) to keep the service worker alive. Without this, Chrome can still terminate the worker during long LLM calls.

---

### 2. Duplicate `parseRepoFromUrl` Implementations
**Files:**
- `src/shared/repo.ts` — Used by the UI (`App.tsx`)
- `src/background/repo/url.ts` — Never imported by anyone

Two separate implementations of URL-to-RepoRef parsing exist with **different logic** (especially for GitLab URLs). The `url.ts` version uses a simpler regex that doesn't handle nested GitLab groups. This is confusing and error-prone.

**Fix:** Delete `src/background/repo/url.ts` and use `src/shared/repo.ts` everywhere.

---

### 3. GitHub Blob Fetches Are Unbounded Parallel Requests
**File:** `src/background/repo/github.ts:260-278`

All candidate files (up to 1200) are fetched in parallel via `Promise.all`. This can:
- Trigger GitHub API rate limits (60 unauthenticated / 5000 authenticated per hour)
- Create massive memory pressure with hundreds of concurrent requests
- Cause net::ERR_INSUFFICIENT_RESOURCES in the service worker

**Fix:** Use a concurrency limiter (e.g., process in batches of 10-20 concurrent requests).

---

### 4. Gemini System Prompt Sent as User Message
**File:** `src/background/llm/gemini.ts:46-54`

The Gemini adapter sends the system prompt as a `user` role message instead of using Gemini's `systemInstruction` field. This degrades prompt quality because the model treats it as user input rather than system instructions.

**Fix:** Use `systemInstruction` field in the Gemini API request body.

---

### 5. No Error Handling for Base64 Decode of Large Files
**File:** `src/background/repo/github.ts:106`

`atob()` is used for base64 decoding, which doesn't handle non-ASCII characters (e.g., UTF-8 encoded files with special characters). Large files with international characters will produce garbled output.

**Fix:** Use `TextDecoder` + `Uint8Array` pattern for proper UTF-8 handling.

---

## 🟡 Incomplete Implementations / TODO Items

### 6. No Cancel Button in the UI
**File:** `src/popup/App.tsx:873-890`

The footer actions include Scan, Generate, Download, and Clear — but no **Cancel** button. The `CANCEL_JOB` command exists in the service worker and message types, but there's no UI surface to trigger it. Users have no way to abort a long-running generation.

**Fix:** Add a "Cancel" button visible when `busy === true`.

---

### 7. `CANCEL_JOB` Only Aborts Generation, Not Scans
**File:** `src/background/service-worker.ts:560-570`

The cancel handler only aborts via `activeAbortController` which is set during generation. Scan operations (`runScanPipeline`) have no abort mechanism — `scanInFlight` is a flag but there's no `AbortController` wired to it.

**Fix:** Wire an `AbortSignal` through the scan pipeline.

---

### 8. Claude `max_tokens` Is Hardcoded to 6000
**File:** `src/background/llm/claude.ts:43`

The Claude adapter hardcodes `max_tokens: 6000`. For batches with many endpoints, this may truncate the response. OpenAI and Gemini don't have equivalent hard limits in the request.

**Fix:** Make `max_tokens` dynamic based on batch size, or make it configurable in settings.

---

### 9. No Rate Limiting for GitHub/GitLab API Calls
**Files:** `src/background/repo/github.ts`, `src/background/repo/gitlab.ts`

No rate-limit awareness exists. When hitting API rate limits, the retry logic will just retry and fail again. There's no backoff based on `X-RateLimit-Remaining` or `Retry-After` headers.

**Fix:** Read rate-limit headers and implement intelligent backoff.

---

### 10. Settings Are Saved on Every Keystroke (API Keys)
**File:** `src/popup/App.tsx:549-557`

API key inputs trigger `patchSettings()` on every `onChange` event (every keystroke). This writes to `chrome.storage.local` on each character typed, causing unnecessary I/O and potential race conditions.

**Fix:** Use `onBlur` for API key persistence (like test directories already do), or debounce the save.

---

### 11. `hardTimeoutMs` Is Never Configured
**File:** `src/background/llm/fetchWithTimeout.ts:32-35`

The `fetchWithTimeout` supports a `hardTimeoutMs` option separate from the soft timeout, but **no caller ever passes it**. The hard timeout falls back to `timeoutMs`, making both timers identical.

**Fix:** Pass `hardTimeoutMs` as a configurable multiple of `timeoutMs` (e.g., 2x).

---

### 12. Python Parser Only Uses Regex (No AST)
**File:** `src/background/parser/codeRouteParser.ts:859-903`

JavaScript frameworks get full Babel AST analysis, but Python files (FastAPI/Flask) only get regex scanning. This misses:
- Routes defined via variables
- Multi-line decorator arguments
- `include_router` / blueprint mounts

**Fix:** Implement a lightweight Python AST approach or enhance regex patterns.

---

### 13. Coverage Gaps Are Capped at 20 Items
**File:** `src/background/generation/coverage.ts:49`

The `gaps` array is sliced to 20 items with `.slice(0, 20)`. For large repos with many endpoints, important gaps are silently hidden.

**Fix:** Return all gaps and let the UI handle pagination/truncation.

---

### 14. Quality Issues Also Capped at 20
**File:** `src/background/generation/testGenerator.ts:286`

Same pattern — quality assessment issues are silently truncated at 20. Critical issues after #20 are lost.

---

## 🟠 Code Quality / Refactoring Opportunities

### 15. Massive Code Duplication Between GitHub and GitLab Scanners
**Files:** `src/background/repo/github.ts`, `src/background/repo/gitlab.ts`

Both files duplicate:
- `MAX_FILES`, `ALLOWED_EXTENSIONS`, `EXCLUDED_SEGMENTS` constants
- `supportsPath()`, `shouldExcludePath()`, `rankPath()`, `sortCandidates()` functions
- Almost identical filtering and ranking logic (~50 duplicated lines)

**Fix:** Extract shared utilities into `src/background/repo/shared.ts`.

---

### 16. Duplicated Utility Functions Between `promptBuilder.ts` and `testGenerator.ts`
**Files:** `src/background/llm/promptBuilder.ts`, `src/background/generation/testGenerator.ts`

Both files independently define:
- `METHOD_DEFAULTS` mapping
- `defaultExpectedStatus` / `defaultExpectedStatusForEndpoint`
- `sampleValueForField` / `sampleValueForParam`
- `buildExamplePath` (nearly identical implementations)

**Fix:** Extract into a shared utility module.

---

### 17. `App.tsx` Is a 894-Line Monolithic Component
**File:** `src/popup/App.tsx`

The entire UI is a single React component with no subcomponents. It contains settings modal, progress timeline, endpoint list, coverage panel, performance panel, and action footer all inlined.

**Fix:** Break into smaller components: `SettingsModal`, `ProgressTimeline`, `EndpointList`, `CoveragePanel`, `PerformancePanel`, `ActionFooter`.

---

### 18. Framework-Specific Parsers Are Trivial Wrappers
**Files:** `expressParser.ts`, `fastifyParser.ts`, `honoParser.ts`, `koaParser.ts`, `nestParser.ts`, `nextParser.ts`, `pythonParser.ts`

Each is an identical 6-line file that calls `parseCodeRoutes()` then filters by source. These add no logic — they're just aliases.

**Fix:** Either remove them (callers can filter directly) or document why they exist for tree-shaking/modularity reasons.

---

### 19. No Input Validation on API Keys and Tokens
**File:** `src/popup/App.tsx`

API keys are stored with no format validation. Users might accidentally paste malformed keys with trailing whitespace, newlines, or prefix text.

**Fix:** Trim whitespace and validate key format patterns (e.g., `sk-*` for OpenAI, `sk-ant-*` for Claude).

---

### 20. Vite Build Creates Output with Non-Deterministic Hashes
**File:** `vite.config.ts`

Static extension files don't benefit from content hashes in filenames. Chrome extensions load from a fixed directory and don't use CDN caching.

**Fix:** Disable filename hashing in Vite config for extension builds.

---

## 🚀 Missing Features That Would Make APItiser Amazing

> The features below are organized by their impact on developer and QA workflows. These are the gaps that separate a "functional tool" from a "can't-live-without-it" developer tool.

---

### 🔵 A. Core Workflow Gaps — Things Users Expect But Can't Do

#### A1. **Postman / Insomnia Collection Export**
**Impact: 🔥🔥🔥 Critical for adoption**

Currently APItiser only exports runnable test files (Jest/Mocha/Pytest). But most developers and QA engineers already use Postman or Insomnia for API testing. Exporting to **Postman Collection v2.1 JSON** or **Insomnia YAML** would instantly make every scanned endpoint usable in their existing workflow — without even running the generated tests.

- The `GeneratedTestCase` already has `request.method`, `request.path`, `request.headers`, `request.query`, `request.body` — everything needed for a Postman request.
- Add a "Export to Postman" button alongside "Download Tests".
- Include environment variables template (`{{baseUrl}}`, `{{apiToken}}`).

---

#### A2. **Run Tests In-Browser Against a Live Server**
**Impact: 🔥🔥🔥 Killer differentiator**

Right now users must: Download ZIP → extract → `npm install` → configure env → `npx jest`. That's 5 steps before seeing results. Instead, offer a **"Run Tests" button** that executes test requests directly from the extension against a user-specified base URL.

- The `GeneratedTestCase` structure already contains complete request/response specs.
- Use `fetch()` from the service worker to send actual requests.
- Show pass/fail results in-panel with response diffs.
- This single feature would make APItiser a **complete API testing tool** rather than just a test generator.

---

#### A3. **Incremental Re-Scan / Diff-Aware Scanning**
**Impact: 🔥🔥 High for repeat users**

If a dev re-scans the same repo after making changes, APItiser scans the entire repo from scratch. This wastes time and API quota. Instead:

- Cache the previous scan's file SHAs in `chrome.storage.local`.
- On re-scan, only fetch files whose SHA has changed.
- Highlight **new/modified/removed** endpoints compared to the previous scan.
- This would reduce scan time from minutes to seconds for active development.

---

#### A4. **Custom Base URL for Test Execution**
**Impact: 🔥🔥 Essential for real use**

Generated tests hardcode `http://localhost:3000`. There's no way to configure the target base URL per-repo. Different repos run on different ports/hosts.

- Add a `baseUrl` field to `ExtensionSettings` (per context).
- Inject it into generated test files dynamically.
- Essential for the in-browser test runner (A2).

---

#### A5. **Selective Re-Generation**
**Impact: 🔥🔥 Key QA workflow**

After generating tests, QA may want to **re-generate tests for a specific endpoint** without re-doing the entire batch. Currently it's all-or-nothing. Add:

- Right-click / action on individual endpoints to "Regenerate".
- Preserve existing good tests for other endpoints.
- This is especially important after editing the LLM prompt or switching providers.

---

### 🟣 B. Developer Experience Features

#### B1. **Test Code Preview & In-Panel Editor**
**Impact: 🔥🔥🔥 Developers want to see before downloading**

Tests are generated, packaged into a ZIP, and blindly downloaded. Developers want to:

- **Preview** generated test code in-panel before downloading.
- **Edit** individual test cases (title, expected status, request body) in the UI.
- **Delete** weak or irrelevant tests before packaging.
- The `GeneratedTestCase[]` and `GeneratedFile[]` data is already in state — it just needs a UI surface.

---

#### B2. **Copy Individual Tests to Clipboard**
**Impact: 🔥🔥 Quick integration**

Often a developer just wants **one specific test** copied to paste into their existing test file. Add a "Copy" button per test case that renders the test in the selected framework and puts it on the clipboard.

---

#### B3. **Environment Variable Template Generation**
**Impact: 🔥🔥 Reduces setup friction**

Generated tests reference `{{API_TOKEN}}`, `API_BASE_URL`, etc., but there's no `.env.example` file generated. Add:

- Auto-generate a `.env.example` with all placeholder variables.
- Include it in the ZIP alongside test files.
- Add instructions in README for each variable.

---

#### B4. **Shareable Scan Report / HTML Export**
**Impact: 🔥🔥 Team collaboration**

After scanning, there's no way to share the API surface map with teammates who don't have the extension. Generate a **standalone HTML report** containing:

- All detected endpoints with method, path, source, confidence.
- Coverage summary and gap analysis.
- Auto-detected auth patterns.
- This becomes a valuable API documentation artifact, not just test input.

---

#### B5. **Custom Prompt Templates / Instructions**
**Impact: 🔥🔥 Power users**

The LLM prompts are hardcoded in `promptBuilder.ts`. Power users (especially QA leads) want to customize:

- Add domain-specific testing rules ("always test pagination with limit=0").
- Specify naming conventions for test titles.
- Add project-specific auth patterns or middleware behavior.
- Add a "Custom Instructions" textarea in Settings that gets appended to the LLM prompt.

---

#### B6. **TypeScript Generated Tests (Not Just JS)**
**Impact: 🔥🔥**

The Jest and Mocha adapters generate `.test.js` files. Most modern projects use TypeScript. Add a toggle to generate `.test.ts` files with proper typing.

---

### 🟤 C. QA-Specific Features — What QA Engineers Need

#### C1. **Test Data Parametrization**
**Impact: 🔥🔥🔥 Core QA technique**

Currently each test has one hardcoded request. Real QA needs **data-driven testing** with multiple input sets per endpoint:

- Generate a test data table (CSV/JSON) alongside test files.
- Use `test.each()` (Jest) / parameterized fixtures (Pytest) for multiple scenarios.
- Include valid, invalid, boundary, and null inputs per field.
- This multiplies test coverage by 3-5× without extra LLM calls.

---

#### C2. **Test Execution History & Regression Tracking**
**Impact: 🔥🔥🔥 Makes APItiser a continuous tool**

Currently APItiser is fire-and-forget: scan → generate → download → done. To become indispensable for QA:

- Track pass/fail results over time (requires the in-browser runner from A2).
- Show regression alerts: "Endpoint X was passing, now failing."
- Compare test results between runs.
- This transforms APItiser from a one-time generator to an ongoing regression guardian.

---

#### C3. **Response Schema Validation Tests**
**Impact: 🔥🔥 API contract testing**

Generated tests only check `status` and `contains` (string matching). They don't validate:

- Response body **JSON schema** structure.
- Required fields present in response.
- Data types match (e.g., `id` is number, `email` is string).
- If OpenAPI spec defines response schemas, auto-generate schema validation assertions.

---

#### C4. **Performance / Load Test Scaffold**
**Impact: 🔥🔥 Beyond functional testing**

Generate lightweight performance test scaffolds:

- k6 or Artillery YAML from detected endpoints.
- Include realistic payloads from the LLM-generated test data.
- Define basic thresholds (response time < 500ms, error rate < 1%).
- This addresses a gap no browser extension currently fills.

---

#### C5. **Authentication Flow Testing**
**Impact: 🔥🔥 Security-focused QA**

The current auth detection marks endpoints as `bearer` / `apiKey` / `none` / `unknown`, but doesn't generate sophisticated auth tests:

- Add **OAuth flow tests** (expired token, wrong scope, revoked token).
- Generate **role-based access tests** (admin vs. user vs. anonymous).
- Test **CORS** and **CSRF** patterns.
- The security test category exists but it's shallow — enhance it with auth-specific scenarios.

---

### 🔵 D. Intelligence & Accuracy Improvements

#### D1. **`$ref` Resolution in OpenAPI Parser**
**Impact: 🔥🔥🔥 Many specs are unusable without this**

Most real-world OpenAPI specs use `$ref` extensively for shared schemas. Without `$ref` resolution, request bodies and response schemas are empty objects, making generated tests generic and low-value.

---

#### D2. **Middleware & Guard Detection**
**Impact: 🔥🔥 Better auth and validation awareness**

The parser detects routes but not the middleware applied to them. Express/Fastify middleware like `authenticate`, `validate`, `rateLimit` would inform:

- More accurate `auth` field on endpoints.
- Better negative and security tests.
- Rate-limit-aware test generation.

---

#### D3. **Cross-Endpoint Dependency Detection**
**Impact: 🔥🔥 Realistic test scenarios**

Many APIs have dependencies: "create user" → "get user by ID". Currently tests are independent. Detect CRUD patterns and generate **workflow tests**:

- POST creates resource → use returned ID in GET/PUT/DELETE.
- This produces far more realistic and valuable test suites.

---

#### D4. **Smart Retry with Provider Fallback**
**Impact: 🔥**

If OpenAI fails (rate limit, outage), fall back to Claude or Gemini automatically. The adapter pattern already supports multiple providers — add automatic failover.

---

### 🟢 E. Enterprise & Team Features

#### E1. **Team Settings Sync via Shared Repository**
Store APItiser configuration (minus API keys) in the repo itself (`.apitiser.json`). When scanning, auto-load project-specific settings (framework, test dirs, categories, custom prompt instructions).

#### E2. **CI/CD Integration Mode**
Expose APItiser logic as a CLI or GitHub Action that can scan + generate in CI. This removes the browser dependency for automated pipelines.

#### E3. **Bitbucket & Azure DevOps Support**
Extend beyond GitHub/GitLab to cover the full enterprise VCS landscape.

#### E4. **Multi-Language Test Output**
Beyond Jest/Mocha/Pytest: add support for Go (`testing`), Java (JUnit/RestAssured), C# (xUnit + RestSharp), Ruby (RSpec). Each language needs a new `TestFrameworkAdapter`.

---

## 🟢 Original Feature Enhancement Opportunities (from initial analysis)

### 21. Add Bitbucket Support
Currently only GitHub and GitLab are supported.

### 22. Add OpenAPI v2 (Swagger) Explicit Support
v2 has structural differences (`basePath`, `definitions` vs `components/schemas`).

### 23. Add Endpoint Grouping/Filtering in UI
Flat list is unmanageable for 100+ APIs.

### 24. Add Streaming LLM Support
All three providers support streaming — better UX and reliability.

### 25. Implement Scan Progress Reporting
Progress jumps from 5% to 60% with no incremental updates.

### 26. Add Dark Mode / Theme Toggle
Essential for developer tools.

### 27. Show File-Level Context in Endpoint Details
`evidence` data exists but isn't surfaced in UI.

---

## 🧪 Test Coverage Gaps

### Current Test Coverage (18 test files)

| Area | Test Files | Status |
|------|-----------|--------|
| apiParser | `unit/apiParser.test.ts` | ✅ |
| codeRouteParser | `unit/codeRouteParser.test.ts` | ✅ |
| expressParser | `unit/expressParser.test.ts` | ✅ |
| fastifyParser | `unit/fastifyParser.test.ts` | ✅ |
| nestParser | `unit/nestParser.test.ts` | ✅ |
| openApiParser | `unit/openApiParser.test.ts` | ✅ |
| testCoverageDetector | `unit/testCoverageDetector.test.ts` | ✅ |
| scanInput | `unit/scanInput.test.ts` | ✅ |
| promptBuilder | `unit/promptBuilder.test.ts` | ✅ |
| frameworkRenderers | `unit/frameworkRenderers.test.ts` | ✅ |
| renderGeneratedFiles | `unit/renderGeneratedFiles.test.ts` | ✅ |
| testGenerator | `unit/testGenerator.test.ts` | ✅ |
| coverage | `unit/coverage.test.ts` | ✅ |
| retry | `unit/retry.test.ts` | ✅ |
| validator | `unit/validator.test.ts` | ✅ |
| github | `unit/github.test.ts` | ✅ |
| stateManager | `integration/stateManager.test.ts` | ✅ |
| generationProgress | `integration/generationProgress.test.ts` | ✅ |

### Missing Test Coverage

| Area | File | Risk |
|------|------|------|
| **GitLab scanner** | `repo/gitlab.ts` | No unit test — pagination, error handling untested |
| **Service worker** | `service-worker.ts` | No integration test for message handling |
| **fetchWithTimeout** | `llm/fetchWithTimeout.ts` | No test for heartbeat, hard timeout, abort |
| **LLM adapters** | `openai.ts`, `claude.ts`, `gemini.ts` | No mock tests for API calls |
| **Emitter** | `core/emitter.ts` | No test |
| **Badge** | `core/badge.ts` | No test |
| **Notifier** | `core/notifier.ts` | No test |
| **KeepAlive** | `core/keepAlive.ts` | No test |
| **Repo URL parser** | `shared/repo.ts` | No test |
| **App.tsx** | `popup/App.tsx` | No component test |
| **Chunks utility** | `utils/chunks.ts` | No test |
| **ID generator** | `utils/id.ts` | No test |

---

## 📋 Prioritized Action Plan

### Phase 1 — Critical Bug Fixes (Immediate)
- [ ] **Fix `keepAlive` listener** — Add actual keep-alive logic in alarm handler
- [ ] **Remove duplicate `repo/url.ts`** — Consolidate to `shared/repo.ts`
- [ ] **Add concurrency limiter to GitHub blob fetches** — Cap at 15 concurrent requests
- [ ] **Fix Gemini system prompt** — Use `systemInstruction` field
- [ ] **Fix UTF-8 base64 decoding** — Replace `atob` with proper decoder

### Phase 2 — Missing UI & UX Features (High Priority)
- [ ] **Add Cancel button to UI** — Show when `busy === true`
- [ ] **Wire cancel to scan operations** — Add AbortController to scan pipeline
- [ ] **Make Claude `max_tokens` dynamic** — Scale with batch size
- [ ] **Debounce API key saves** — Use `onBlur` instead of `onChange`
- [ ] **Show file evidence in endpoint list** — Surface `evidence[0].filePath` and `reason`

### Phase 3 — Code Quality & Refactoring (Medium Priority)
- [ ] **Extract shared repo utilities** (`supportsPath`, `rankPath`, etc.)
- [ ] **Extract shared prompt/test utilities** (`METHOD_DEFAULTS`, `sampleValueForField`)
- [ ] **Break `App.tsx` into subcomponents** — `SettingsModal`, `EndpointList`, etc.
- [ ] **Remove or justify trivial parser wrappers** (6 files)
- [ ] **Add API key format validation**
- [ ] **Return all coverage gaps** — Remove `.slice(0, 20)` truncation

### Phase 4 — Test Coverage Expansion (Medium Priority)
- [ ] **Add GitLab scanner tests** — Mock pagination, error paths
- [ ] **Add `fetchWithTimeout` tests** — Heartbeat, hard timeout, abort
- [ ] **Add LLM adapter mock tests** — Error responses, retries
- [ ] **Add `shared/repo.ts` URL parsing tests** — Edge cases, nested GitLab groups
- [ ] **Add chunks/id utility tests**

### Phase 5 — Feature Enhancements (Future)
- [ ] **Add `$ref` resolution to OpenAPI parser**
- [ ] **Add rate-limit awareness** — Read GitHub/GitLab rate-limit headers
- [ ] **Configure `hardTimeoutMs`** — Default to 2× soft timeout
- [ ] **Enhance Python parser** — Handle `include_router`, blueprints, multi-line decorators
- [ ] **Add endpoint grouping in UI**
- [ ] **Add test preview before download**
- [ ] **Add settings export/import**
- [ ] **Add Bitbucket support**
- [ ] **Add streaming LLM responses**
- [ ] **Add dark mode**

---

## File Inventory

| Directory | Files | Lines | Purpose |
|-----------|-------|-------|---------|
| `src/background/` | 1 | 773 | Service worker orchestration |
| `src/background/core/` | 5 | 349 | State, emitter, badge, notifier, keepAlive |
| `src/background/generation/` | 3 + 5 | 850 | Test generation, coverage, zip, framework adapters |
| `src/background/llm/` | 5 | 568 | LLM adapters and prompt builder |
| `src/background/parser/` | 12 | ~1,300 | Route detection (Babel AST + OpenAPI + Python regex) |
| `src/background/repo/` | 5 | 482 | GitHub/GitLab scanning, validation, URL parsing |
| `src/background/utils/` | 3 | 68 | Retry, chunks, ID generator |
| `src/popup/` | 3 | 911 | React UI |
| `src/shared/` | 4 | 413 | Types, messages, constants, repo URL parsing |
| `tests/` | 18 | — | Unit and integration tests |
| **Total** | **~51** | **~5,500** | |
