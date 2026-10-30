# APItiser local runner — native host install

This one-time setup lets the APItiser extension boot a repo's service locally (via
[`runLocal`](../../runLocal)) and validate the generated suite against it — without you starting
the service by hand and without any hosted backend. Chrome launches a small Node host on demand
and talks to it over a native-messaging port; the host runs `runLocal` and tears it down when
you're done.

## Why a native host (and what it can/can't do)

A Manifest V3 extension runs in the browser sandbox: it cannot spawn processes, run a shell, or
start a server. Native Messaging is Chrome's supported escape hatch — a locally-installed,
ID-pinned helper the extension may talk to. It is **not** a server you deploy or leave running;
Chrome spawns it per session and pipes to it over stdio.

**Trust model:** installing the host means you trust the APItiser extension (pinned by its
extension ID in the host manifest's `allowed_origins`) to run your local repositories via
`runLocal`, plus `git` (to find or clone the repo you press Start on) and `docker compose` (to
start that repo's own databases when they aren't already running). Nothing else is executed.

## Prerequisites

- Node.js on your `PATH` (the host is a Node script).
- The `runLocal` tool available on disk (default lookup: a `runLocal/` folder next to this repo).
- `git` plus whatever toolchain your target repo needs (Node/Python/Go/…); `runLocal` checks lazily.

## Install (macOS / Linux)

1. Load the unpacked extension at `chrome://extensions` (Developer mode) and copy its **ID**.
2. Register the host:

   ```bash
   cd native-host
   ./install.sh <EXTENSION_ID>
   # optional custom host name: ./install.sh <EXTENSION_ID> com.apitiser.localrunner
   ```

   This writes `com.apitiser.localrunner.json` into the NativeMessagingHosts directory of every
   Chromium-based browser profile it finds (Chrome, Chromium, Brave, Edge), pointing at a
   generated launcher (which calls node by absolute path, so nvm/Homebrew node works under
   Chrome's minimal PATH) and locking access to your extension ID.
3. That's it. Open any GitHub/GitLab repo page, open APItiser, and press **Start** under
   **Run in Browser**. No settings needed.

## What Start does

1. **Finds the code.** Uses your existing clone of that repo if one is anywhere under your home
   folder (matched by its `origin` remote, up to 3 levels deep; `Desktop`, `Documents` and
   `Downloads` are skipped to avoid macOS privacy prompts). Otherwise it shallow-clones into
   `~/.apitiser/repos/<host>/<owner>/<repo>` and refreshes that copy on later Starts. Private
   repos use the GitHub/GitLab token from Settings, sent as a one-off header — never saved in
   `.git/config`.
2. **Picks the API.** Boots the folder the scan found the routes in (e.g. `backend/`), not the
   whole `docker compose` stack.
3. **Starts the databases it needs.** For each database/queue in the repo's compose file
   (Mongo, Redis, Postgres, …): reuses it if it's already listening locally, otherwise starts just
   that service with Docker. Only services APItiser started are stopped on Stop.
4. **Creates `.env`** from the repo's sample (`.env.example`, `env.sample`, …) if missing.
5. **Boots the API on a free port** (your existing virtualenv is reused; installs are skipped
   when requirements haven't changed). Tests run against it.
6. **Boots the frontend** (if the repo has one) on another free port, pointed at the API. It's
   listed in the panel with its URL; a frontend problem never blocks testing the API.

**Override:** *Settings → Local runner → local repo path* forces a specific folder — used only when
it's a clone of the repo you're on, so a stale path can't start the wrong app.

## Windows

Run the bundled PowerShell installer from the unzipped folder (it writes a `.bat` launcher,
drops the host manifest, and adds the per-user registry keys for Chrome/Edge/Brave/Chromium):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 <EXTENSION_ID>
```

Prerequisites on Windows: **Node.js** and **Git for Windows** (which provides `bash`) on your
PATH — `runLocal` is a bash tool, so the host runs it through Git Bash (or WSL). To uninstall,
delete the registry keys under `HKCU\Software\<Browser>\NativeMessagingHosts\com.apitiser.localrunner`.

## Where it installs

The installer copies the runner to a stable, non-protected location and registers *that*:
`~/.apitiser/runner` (macOS/Linux) or `%USERPROFILE%\.apitiser\runner` (Windows). This is
important on macOS: running the host directly from `~/Downloads`, `~/Desktop`, or `~/Documents`
fails silently because macOS denies Chrome's native-messaging launcher access to those folders
("Native host has exited"). You can unzip anywhere — the installer moves it out of harm's way.

## Verify / uninstall

- The host writes a diagnostic log to `~/.apitiser-runner.log` — `cat` it after a failed
  "Check setup" to see exactly why the host exited.
- Uninstall: delete `~/.apitiser/runner` and the `com.apitiser.localrunner.json` file from each
  NativeMessagingHosts dir printed by `install.sh` (or the registry keys on Windows).

## How it fits together

```
Side panel ─ RUN_LOCALLY ─▶ service worker ─ connectNative ─▶ apitiser-runner.mjs
                                                                  │ spawn
                                                                  ▼
                                              runLocal: clone? → install → start :PORT
service worker ◀─ {ready, baseUrl} ──────────────────────────────┘
service worker ─ executionValidator ─ fetch ─▶ http://localhost:PORT   (existing engine)
service worker ─ {shutdown}/disconnect ─▶ host kills the process group
```
