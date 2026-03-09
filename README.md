# APItiser Chrome Extension (Phase 1)

APItiser is a Manifest V3 Chrome extension that scans GitHub/GitLab repositories, detects API endpoints, generates API tests using OpenAI/Claude/Gemini, and downloads a runnable zip in Jest, Mocha + Chai, or Pytest format.

## Features

- MV3 service worker orchestration for long-running scan/generation jobs.
- Persistent progress snapshots in `chrome.storage.local`.
- Automatic generation resume from checkpoints after service worker restart.
- Automatic scan/parsing restart from checkpoint after service worker restart.
- GitHub + GitLab API scanning with personal access token support.
- API map construction via Express, Fastify, NestJS route parsing and OpenAPI detection.
- Manual OpenAPI fallback import/paste in popup settings for hard-to-parse repos.
- Multi-LLM provider adapters: OpenAI, Claude, Gemini.
- Test framework adapters: Jest, Mocha + Chai, and Pytest.
- Coverage summary and gap suggestions.
- Access validation for GitHub/GitLab token and host reachability.
- Local run-metric tracking (scan time, generation time, total runtime).
- Downloadable `api-tests.zip` output.

## Stack

- React + TypeScript + Vite (popup UI)
- TypeScript service worker and shared contracts
- JSZip for artifact packaging
- Vitest for unit/integration tests

## Development

```bash
npm install
npm run build
npm test
```

## Load In Chrome

1. Build extension: `npm run build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `/dist`

## Architecture Notes

- `src/background/service-worker.ts`: message routing + job orchestration.
- `src/background/repo/*`: GitHub/GitLab scanners.
- `src/background/parser/*`: Express + OpenAPI parsing.
- `src/background/llm/*`: provider adapters.
- `src/background/generation/*`: test generation, coverage, zip packaging.
- `src/popup/*`: product UI shell.
- `src/shared/*`: typed contracts across popup/worker.
- `docs/CWS_RELEASE_CHECKLIST.md`: release hardening checklist for Chrome Web Store.
