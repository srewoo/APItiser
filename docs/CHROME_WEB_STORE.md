# Chrome Web Store Listing

Submission checklist and copy for publishing APItiser. The extension is store-ready from a
CSP/permissions standpoint (`script-src 'self'`, scoped host permissions, no remote code).

## Build & submit

1. `npm run build:webstore` → produces `apitiser-chrome-webstore.zip` at the repo root.
2. Upload the zip in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
3. Fill in the listing fields below, attach screenshots, set the privacy policy URL.
4. Submit for review. After it is published, the CI tag job also attaches the zip to tagged builds.

Version is tracked as semver in both `package.json` and `public/manifest.json` (currently `2.4.0`).

## Listing copy

**Name:** APItiser - API Integration Test Gen

**Short description (≤132 chars):**
> Generate runnable API integration test suites from GitHub/GitLab repos — detect endpoints, generate with an LLM, validate live.

**Category:** Developer Tools

**Detailed description:**
> APItiser scans a GitHub or GitLab repository, detects API endpoints from source code
> (Express, Fastify, NestJS, Koa, Hono, Next.js, FastAPI, Flask, Django/DRF, Spring Boot,
> JAX-RS, Gin, chi, Echo, gorilla/mux, net/http) and OpenAPI 3.x specs, then generates
> comprehensive test suites with your choice of LLM (OpenAI, Claude, Gemini, or any
> OpenAI-compatible/local server).
>
> Suites are checked by quality gates, optionally validated against a live API with full auth
> support, auto-repaired, and delivered as a downloadable ZIP. Nine framework renderers are
> supported: Jest, Jest+Supertest, Vitest, Mocha, Playwright, Pytest, JUnit5 + REST Assured,
> and Go's testing package. Also exports Postman collections.
>
> Your API keys and repo tokens stay on your machine (chrome.storage.local) and are never sent
> to any APItiser server.

## Screenshots (1280×800 or 640×400)

Capture the core flow end to end:

1. **Scan** — a detected-endpoints list on a repo page (endpoint selection + method filter).
2. **Generate** — the progress timeline with quality status.
3. **Preview** — the generated-test preview modal.
4. **Download / Export** — the readiness assessment and download/Postman actions.
5. **Settings** — provider/model/key configuration (optionally the "Test key" ✓ state).

## Permission justifications

Provide these in the dashboard's permission-justification fields:

| Permission | Why it is needed |
|---|---|
| `storage` | Persist settings, per-tab job state, artifacts, and metrics in `chrome.storage.local`. |
| `tabs` | Read the active tab URL to detect the current GitHub/GitLab repository and scope state per tab. |
| `alarms` | Keep the MV3 service worker alive during long scan/generation jobs and drive checkpoint resume. |
| `downloads` | Save the generated test-suite ZIP, Postman collection, and local-runner bundle. |
| `notifications` | Notify on scan/generation completion and errors. |
| `sidePanel` | The extension UI runs in the Chrome side panel. |
| `nativeMessaging` | **Optional Local Runner only.** A separately installed helper, locked to this extension's ID. On Start it finds or clones the repo being viewed, starts the app on a free `localhost` port (plus its databases via Docker and its frontend), and stops it; opens the OS folder picker when the user chooses a repo folder; and applies a code fix only after the user reviews and approves the diff (backup kept for undo). Talks only to this extension over stdio; network use is limited to cloning the repo and pulling the project's Docker images. Paste-ready text (≤1,000 chars) is below. Trust model: [`native-host/INSTALL.md`](../native-host/INSTALL.md), [ADR 0001](adr/0001-local-runner-native-messaging.md). |

**`nativeMessaging` justification (paste into the dashboard field):**

> Used only by the optional Local Runner: a helper the user installs separately with an install script, locked to this extension's ID in its host manifest. Browser extensions cannot start processes, so when the user presses Start, the extension asks this helper to find (or git clone) the repository the user is viewing, start that app on a free localhost port (plus its databases via Docker and its frontend, if present), and stop it again, so the generated API tests can run against localhost. It also opens the OS folder picker when the user chooses a repo folder, and, only after the user reviews and approves a diff, applies a proposed code fix to that repo's files, keeping a backup for undo. The helper talks only to this extension over stdio; its only network use is cloning/fetching the repository and pulling Docker images the project needs. Without the helper installed, nothing is executed and all other features still work.

**Host permissions:** limited to the repository/provider APIs the extension calls —
`api.github.com`, GitLab (`gitlab.com` + self-hosted `*/api/v4`), the LLM providers
(`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`), and
`localhost`/`127.0.0.1` for the optional local runner. No `<all_urls>`, no remote code.

## Privacy policy

Host `privacypolicy.html` (bundled in the build) at a public URL and enter it in the dashboard.
It states that keys/tokens are stored locally and are only sent to the user-configured
provider/repo APIs — never to an APItiser server.
