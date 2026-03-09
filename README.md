# APItiser Chrome Extension

APItiser is a Manifest V3 Chrome extension that scans GitHub/GitLab repositories, identifies API endpoints, generates API tests with LLMs, and downloads a runnable zip artifact.

## Current Feature Set

- Persistent side panel UX (`chrome.sidePanel`) with per-page context.
- Context-aware state separation by tab + URL path.
- Service-worker-first orchestration for scan, parse, generate, package, and download.
- Checkpointing and resume after worker restart for scan/generation/packaging jobs.
- GitHub and GitLab repository scanning (including configurable GitLab base URL).
- Repository access validation with token/host checks.
- API detection from code routes and OpenAPI documents.
- Supported route detection sources: Express, Fastify, NestJS, Koa, Hono, Next.js route handlers, and FastAPI/Flask decorator patterns.
- OpenAPI fallback (paste or import JSON/YAML spec).
- Existing test coverage detection via configurable test directories.
- LLM providers: OpenAI, Claude, Gemini.
- Test framework renderers: Jest, Mocha + Chai, Pytest.
- Coverage/gap summary, progress timeline, run metrics, badge updates, and notifications.
- Built-in Help and Privacy Policy pages in extension settings.

## Tech Stack

- React + TypeScript + Vite
- Chrome Extension Manifest V3
- TypeScript service worker
- JSZip for downloadable artifacts
- Vitest for unit and integration tests

## Scripts

```bash
npm install
npm run build
npm run test
npm run test:watch
npm run build:webstore
```

- `npm run build`: type-checks and builds extension output into `dist/`.
- `npm run build:webstore`: builds and creates `apitiser-chrome-webstore.zip` for Chrome Web Store upload.

## Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `/Users/sharajrewoo/DemoReposQA/APItiser/dist`.
6. Click the APItiser toolbar icon to open the side panel.

## Usage Flow

1. Open a GitHub or GitLab repository page.
2. Open APItiser from the toolbar icon.
3. In **Settings**, configure provider/model, API keys, framework, test directories, and optional OpenAPI fallback.
4. Click **Validate Access** (recommended for private repos).
5. Click **Scan Repo**.
6. Review detected endpoints and coverage summary.
7. Click **Generate Tests**.
8. Click **Download Tests**.
9. Use **Clear** to reset the current page context (clears generated tests and state for that page).

## Architecture

- `src/background/service-worker.ts`: runtime message handling, orchestration, resume logic, side panel behavior.
- `src/background/repo/*`: GitHub/GitLab scanners and access validator.
- `src/background/parser/*`: route/OpenAPI parsing and existing-test detection.
- `src/background/llm/*`: provider adapters and prompt generation.
- `src/background/generation/*`: test rendering, coverage, zip packaging.
- `src/popup/*`: shared React app shell used by extension UI.
- `src/sidepanel/*`: side panel bootstrap.
- `src/shared/*`: shared message and type contracts.
- `tests/*`: unit and integration coverage for parsers, renderers, retry, state, and generation progress.

## Notes

- Detection is static/heuristic-based for code routes; unusual metaprogramming patterns may require OpenAPI fallback input.
- API keys/tokens are stored in `chrome.storage.local` on the user machine.
