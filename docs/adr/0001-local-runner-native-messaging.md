# ADR 0001 — Run generated tests locally via a native-messaging host

Status: Accepted · Date: 2026-06-22

## Context

APItiser generates API test suites and can validate them in-browser by fetching a live API at
a configured `baseUrl` (`executionValidator`). The gap users hit: they must start the target
service by hand and paste the URL. We want a one-flow "generate → run" against a repo on disk.

`runLocal` (sibling tool) already clones/installs/starts any repo as a local process. The
question was how a browser extension triggers it.

## Constraints

- Manifest V3, no hosted backend.
- A browser extension cannot spawn processes, run a shell, write arbitrary files, or start a
  server — the MV3 service worker is sandboxed. So a *pure* extension cannot boot a service.

## Options

1. **Do nothing** — keep manual start + paste URL. Zero work, poor UX.
2. **Smooth manual** — export the suite + a generated `run.sh`; the dev runs it once, the
   extension auto-validates against the booted port. No install, but not automatic.
3. **Localhost companion daemon** — a long-lived local server the extension calls via fetch.
   Simple, but it *is* a backend (a server you run) and needs a listening port + CORS.
4. **Native messaging host** — Chrome spawns an ID-pinned local helper on demand and pipes to
   it over stdio (supported in MV3). The host wraps `runLocal`; the extension's existing
   validator does the test run. No hosted/listening backend; one-time local host install.

## Decision

**Option 4.** A native messaging host (`native-host/apitiser-runner.mjs`) wraps `runLocal`:
boot the repo on a port, poll until it accepts connections, report `ready`, tear down on
disconnect. The service worker (`RUN_LOCALLY` command) then points the existing
`executionValidator` at `http://localhost:<port>` and finalizes the artifact with live results.

The host's only responsibility is the service lifecycle; all generation/validation logic is
reused. The bridge (`bootRepoService`) is pure logic over a `NativeMessagingAdapter`, unit-
tested with an in-memory port double.

### Protocol (stdio, 4-byte LE length + JSON)

- extension → host: `boot{repoPath,port,runLocalScriptPath?,cmd?,stack?,installTimeoutMs?}`,
  `shutdown`, `ping`.
- host → extension: `status{phase,message}`, `log{line}`, `ready{port,baseUrl}`, `error{message}`,
  `pong`.

## Trade-offs / reversibility

- **Cost:** a one-time host install (script + manifest naming the extension ID) and the
  `nativeMessaging` permission + `http://localhost/*` host permission. Unavoidable for any
  "run local code from a browser" feature.
- **Reversible:** two-way door. Deleting the host manifest disables it; the extension degrades
  to manual `baseUrl` validation. No data model changes are entangled.
- **Trust:** installing the host = trusting the (ID-pinned) extension to run local repos via
  `runLocal`. The host executes only `runLocal` with the configured repo/port/overrides.

## Risks

- MV3 service-worker lifetime during long installs — mitigated by the active native port and the
  existing keep-alive; very long installs may still need a re-trigger.
- Windows requires a registry key + a `.bat` shim (the `.mjs` shebang is POSIX-only) — documented
  in `native-host/INSTALL.md`.

## Consequences

New: `native-host/` (host + installer + docs), `src/background/runner/localRunner.ts`,
`NativeMessagingAdapter` in the platform layer, `RUN_LOCALLY` command, "Run Locally" button,
Local Runner settings. Manifest gains `nativeMessaging` + localhost host permissions.
