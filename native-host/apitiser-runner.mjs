#!/usr/bin/env node
/**
 * APItiser local-runner native messaging host.
 *
 * Chrome launches this on demand (chrome.runtime.connectNative) and pipes JSON to it over
 * stdio using the native-messaging framing (4-byte little-endian length prefix + UTF-8 JSON).
 * Its single job: boot a repo's service via runLocal, poll the port until it accepts
 * connections, and report readiness back to the extension — which then runs the generated
 * suite against http://localhost:<port>. On shutdown / disconnect it tears the service down.
 *
 * Trust model: installing this host means trusting the APItiser extension (pinned by ID in
 * the host manifest's allowed_origins) to run local repositories via runLocal. The host
 * executes ONLY runLocal with the given repo path and port — it does not eval arbitrary input
 * beyond the optional --cmd override you configure, which runLocal would run anyway.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloneDestination,
  cloneOrUpdate,
  ensureEnvFile,
  expandHome,
  folderPickerCommand,
  findComposeFile,
  findLocalClone,
  frontendEnv,
  infraServices,
  normalizeRemote,
  parseComposeServices,
  readOriginUrl,
  searchRootsFor,
  pickApiDir,
  pickFrontendDir
} from './stack.mjs';
import { applyEdits, readRepoFiles, restoreBackup } from './codeEdits.mjs';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_LINES = 400;
const MAX_FRAME_BYTES = 1024 * 1024; // Chrome caps native-messaging frames at 1 MB

// True only when this file is executed directly (Chrome launches it), false when imported by a
// test. Gates the stdin/process wiring so importing the pure helpers has no side effects.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

// --- Pure, unit-testable helpers (exported) ----------------------------------

/** A valid TCP port: integer in [1, 65535]. */
export const isValidPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

/**
 * The port a dev server announces in its own output ("listening on 3000",
 * "Uvicorn running on http://127.0.0.1:8000", "Local: http://localhost:5173/"), or undefined.
 * Used when an app ignores the PORT we gave it and binds its own.
 */
export const portFromLogLine = (line) => {
  const text = String(line);
  const url = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\b/i.exec(text);
  const phrase = /\b(?:listening|running|started|serving|server)\b[^\n]{0,40}?\bport\b\D{0,3}(\d{2,5})\b/i.exec(text)
    ?? /\blistening (?:on|at)\b\D{0,3}(\d{2,5})\b/i.exec(text);
  // A URL only counts on a line that announces a server — not "Connected to mongodb://localhost:27017".
  const announcesServer = /\b(listen|running|started|serving|server|local|available|ready|bound)\b/i.test(text);
  const port = Number(((announcesServer ? url : null) ?? phrase)?.[1]);
  return isValidPort(port) && !KNOWN_DB_PORTS.has(port) ? port : undefined;
};

/**
 * True when `dest` resolves to `root` itself or a path strictly inside it — used to reject a
 * `../` traversal in a generated file path before writing it to disk.
 */
export const isPathInsideDir = (root, dest) => {
  const resolvedRoot = path.resolve(root);
  const resolvedDest = path.resolve(root, dest);
  return resolvedDest === resolvedRoot || resolvedDest.startsWith(resolvedRoot + path.sep);
};

/**
 * Decode native-messaging frames (4-byte LE length prefix + UTF-8 JSON) from a buffer.
 * Returns parsed messages, the unconsumed remainder, and the first error encountered
 * (`oversized` or `malformed`). Pure: no I/O, no side effects.
 */
export const decodeFrames = (buffer, maxBytes = MAX_FRAME_BYTES) => {
  const messages = [];
  let rest = buffer;
  let error;
  while (rest.length >= 4) {
    const length = rest.readUInt32LE(0);
    if (length > maxBytes) {
      error = 'oversized';
      rest = Buffer.alloc(0);
      break;
    }
    if (rest.length < 4 + length) break;
    const body = rest.subarray(4, 4 + length);
    rest = rest.subarray(4 + length);
    try {
      messages.push(JSON.parse(body.toString('utf8')));
    } catch {
      error = 'malformed';
    }
  }
  return { messages, rest, error };
};

// Diagnostic log to a file (NEVER stdout — stdout carries only native-messaging frames).
// `cat ~/.apitiser-runner.log` after a failed "Check setup" shows exactly why the host exited.
const DIAG_LOG = path.join(os.homedir(), '.apitiser-runner.log');
const diag = (message) => {
  try {
    appendFileSync(DIAG_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* logging must never throw */
  }
};
diag(`host started — node ${process.version}, platform ${process.platform}, argv=${JSON.stringify(process.argv.slice(2))}`);
process.on('exit', (code) => diag(`process exit code=${code}`));
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * macOS Gatekeeper refuses to execute binaries carrying the `com.apple.quarantine` extended
 * attribute ("<tool> can't be opened because Apple cannot check it for malicious software").
 * Repos obtained via a browser download, or their node_modules, often inherit that flag — so a
 * boot that runs a native tool (esbuild/vite, swc, etc.) dies mid-way. Best-effort strip of the
 * attribute across the repo (recursive) before we boot. No-op off macOS; failures are ignored.
 */
const stripQuarantineMac = (targetPath) => {
  if (!isMac || !targetPath) return;
  // Only downloaded repos carry the flag (git clones never do). Walking a big repo + venv
  // recursively costs ~20s, so check the folder itself and its marker files first.
  const flagged = [targetPath, ...['package.json', 'requirements.txt', 'go.mod', 'pom.xml'].map((f) => path.join(targetPath, f))]
    .filter((p) => existsSync(p))
    .some((p) => spawnSync('xattr', ['-p', 'com.apple.quarantine', p], { stdio: 'ignore', timeout: 5000 }).status === 0);
  if (!flagged) return;
  try {
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', targetPath], { stdio: 'ignore', timeout: 20000 });
    diag(`stripped com.apple.quarantine from ${targetPath}`);
  } catch (error) {
    diag(`quarantine strip skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
};

// runLocal is a bash tool. POSIX has bash natively; on Windows we run it through Git Bash
// (or WSL). Resolve an absolute bash so it works even when PATH is minimal.
const resolveBash = () => {
  if (!isWindows) {
    return 'bash';
  }
  const candidates = [
    process.env.APITISER_BASH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\Windows\\System32\\bash.exe' // WSL
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'C:\\Windows\\System32\\bash.exe' || existsSync(candidate)) || 'bash';
};

/**
 * Chrome launches the host with a minimal PATH (/usr/bin:/bin:...), which it passes down to
 * runLocal — so npm/node/python/go living in /usr/local/bin, Homebrew, or nvm aren't found
 * and the service exits with code 127. Prepend the real toolchain locations (including the
 * dir of the node actually running this host, which covers nvm/Homebrew installs).
 */
const buildChildEnv = (port) => {
  const sep = path.delimiter;
  const home = os.homedir();
  const extra = isWindows
    ? [
        path.dirname(process.execPath), // node dir (covers npm)
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
      ].filter(Boolean)
    : [
        path.dirname(process.execPath), // e.g. /usr/local/bin or ~/.nvm/.../bin (covers node+npm)
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/go/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, 'go', 'bin'),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
      ];
  const existing = process.env.PATH ? process.env.PATH.split(sep) : [];
  const merged = [...extra, ...existing].filter((value, index, all) => value && all.indexOf(value) === index).join(sep);
  const env = { ...process.env, PATH: merged };
  if (port) {
    env.PORT = String(port);
  }
  return env;
};

// --- native messaging framing -------------------------------------------------
const send = (message) => {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
};

const status = (phase, message) => send({ type: 'status', phase, message });
const fail = (message) => send({ type: 'error', message });

let logCount = 0;
const log = (line) => {
  for (const raw of String(line).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || logCount >= MAX_LOG_LINES) {
      continue;
    }
    logCount += 1;
    send({ type: 'log', line: trimmed.slice(0, 500) });
  }
};

// --- service lifecycle --------------------------------------------------------
let child = null;
let shuttingDown = false;
let bootSettled = false; // true once boot reached a terminal state (ready / failed / timed out)
let serviceReady = false; // true while a booted service is up (after `ready`, until it exits)

const resolveRunLocal = (override) => {
  const candidates = [
    override,
    process.env.APITISER_RUNLOCAL,
    // Downloaded bundle (flat): apitiser-runner.mjs next to a runLocal/ folder.
    path.resolve(HOST_DIR, 'runLocal', 'run-local.sh'),
    // Repo layout: <...>/APItiser/native-host alongside <...>/runLocal
    path.resolve(HOST_DIR, '..', '..', 'runLocal', 'run-local.sh'),
    path.resolve(HOST_DIR, '..', 'runLocal', 'run-local.sh')
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
};

// --- automation helpers (Docker, port detection, Python env) -----------------
const KNOWN_DB_PORTS = new Set([27017, 6379, 5432, 3306, 9200, 9300, 5672, 15672, 11211, 8200, 2379]);

const repoIsDockerised = (repoPath) =>
  ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile'].some((f) =>
    existsSync(path.join(repoPath, f))
  );

const dockerDaemonUp = () => {
  try {
    return spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 8000 }).status === 0;
  } catch {
    return false;
  }
};

/** Start Docker (if installed) and wait for the daemon, so a compose repo boots unattended. */
const ensureDocker = async (repoPath, deadline) => {
  if (!repoIsDockerised(repoPath) || dockerDaemonUp()) {
    return;
  }
  const hasDocker = (() => {
    try {
      return spawnSync('docker', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
    } catch {
      return false;
    }
  })();
  if (!hasDocker) {
    throw new Error('This repo needs Docker, but the `docker` CLI was not found. Install Docker Desktop and retry.');
  }
  status('starting', 'Docker is not running — starting it…');
  try {
    if (process.platform === 'darwin') {
      spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', 'Docker Desktop'], { detached: true, stdio: 'ignore', windowsHide: true });
    } else {
      spawnSync('systemctl', ['--user', 'start', 'docker'], { stdio: 'ignore', timeout: 8000 });
    }
  } catch {
    /* best effort; we poll below regardless */
  }
  while (!shuttingDown) {
    if (dockerDaemonUp()) {
      status('starting', 'Docker is ready.');
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('Docker did not become ready in time. Start Docker Desktop manually and retry.');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
};

/** Best-effort: read the app's published port from a compose file, skipping DB/infra ports. */
const detectComposePort = (repoPath) => {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    .map((f) => path.join(repoPath, f))
    .find((p) => existsSync(p));
  if (!file) {
    return undefined;
  }
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const published = [];
  for (const match of text.matchAll(/(?:^|\s)-?\s*["']?(\d{2,5}):(\d{2,5})["']?/g)) {
    const host = Number(match[1]);
    if (Number.isFinite(host) && !KNOWN_DB_PORTS.has(host)) {
      published.push(host);
    }
  }
  if (!published.length) {
    return undefined;
  }
  // Prefer a conventional app port if present, else the first non-DB published port.
  return published.find((p) => [8000, 8080, 3000, 5000, 4000, 8888].includes(p)) ?? published[0];
};

/** Pick a Python interpreter >= 3.11 (the repo above needed datetime.UTC); fall back to python3. */
const pickPython = () => {
  // Use the AUGMENTED PATH (Homebrew/nvm/etc.) — Chrome gives the host a minimal PATH that
  // would otherwise miss /opt/homebrew/bin/python3.11 and fall back to system 3.9.
  const env = buildChildEnv();
  for (const bin of ['python3.13', 'python3.12', 'python3.11', 'python3']) {
    try {
      const out = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8', timeout: 5000, env });
      if (out.status === 0) {
        const m = /\((\d+),\s*(\d+)\)/.exec(out.stdout || '');
        if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11))) {
          return bin;
        }
      }
    } catch {
      /* try next */
    }
  }
  return 'python3';
};

/** One connect attempt; true if something accepts on host:port. */
const canConnect = (port, host) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });

// `localhost` servers can bind IPv4 or IPv6 only (Node ≥17 on macOS often picks ::1).
export const isPortOpen = async (port) => (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1'));

/** Ask the OS for a free port. Common dev ports (3000/8000/8080) are often already taken. */
export const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/**
 * Wait until the service accepts connections on the requested port, or on a port it announced
 * in its own logs (`announced()`, for apps that ignore PORT). Resolves with the port that opened.
 */
const waitForPort = (port, announced, deadline) =>
  new Promise((resolve, reject) => {
    const attempt = async () => {
      if (shuttingDown) {
        reject(new Error('shutting down'));
        return;
      }
      for (const candidate of [port, ...announced().filter((p) => p !== port)]) {
        if (await isPortOpen(candidate)) {
          resolve(candidate);
          return;
        }
      }
      if (Date.now() > deadline) {
        reject(new Error(`port ${port} did not open before timeout`));
      } else {
        setTimeout(attempt, 500);
      }
    };
    void attempt();
  });

let sigkillTimer = null;

const killChild = () => {
  if (!child || child.killed || !child.pid) {
    return;
  }
  const ref = child;
  if (isWindows) {
    // Kill the whole process tree (taskkill /T) — Windows has no POSIX process groups.
    try {
      spawn('taskkill', ['/pid', String(ref.pid), '/t', '/f'], { windowsHide: true });
    } catch {
      try {
        ref.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    // Negative pid → kill the whole process group started with detached:true.
    process.kill(-ref.pid, 'SIGTERM');
  } catch {
    try {
      ref.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Escalate to SIGKILL only if the group is still alive. The timer is cleared in the child's
  // 'exit' handler so we never fire SIGKILL at a PID the OS may have recycled.
  if (sigkillTimer) {
    clearTimeout(sigkillTimer);
  }
  sigkillTimer = setTimeout(() => {
    sigkillTimer = null;
    try {
      process.kill(-ref.pid, 0); // probe — throws if the group is already gone
      process.kill(-ref.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 4000);
};

/** Progress of one part of the stack (database, frontend…) shown in the extension. */
const component = (name, state, message, url) => send({ type: 'component', name, status: state, message, url });

const tildify = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

// Everything Start brings up besides the API process, so Stop / disconnect tears it all down.
const extraChildren = new Set(); // e.g. the frontend dev server
let startedInfra = null; // { compose, names } — only services WE started, never pre-existing ones

const killGroup = (ref) => {
  if (!ref?.pid) return;
  try {
    if (isWindows) spawn('taskkill', ['/pid', String(ref.pid), '/t', '/f'], { windowsHide: true });
    else process.kill(-ref.pid, 'SIGTERM');
  } catch {
    try {
      ref.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
};

const stopInfra = () => {
  if (!startedInfra) return;
  const { compose, names } = startedInfra;
  startedInfra = null;
  diag(`stopping infra: ${names.join(', ')}`);
  spawnSync('docker', ['compose', '-f', compose, 'stop', ...names], { stdio: 'ignore', timeout: 30_000 });
};

/**
 * Where the code is, in order: the folder the user chose for this repo (only if it really is a
 * clone of it), an existing clone found in the user's folders, else a fresh clone — into the
 * user's "clone repos into" folder, or APItiser's managed folder. Reports the choice as a
 * `source` event so the panel can show (and let the user change) it.
 */
const resolveSource = async (msg) => {
  const chosen = expandHome(msg.repoPath);
  const repo = msg.repo;
  const report = (dir, kind) => {
    send({ type: 'source', path: dir, kind });
    return dir;
  };
  if (chosen) {
    const origin = normalizeRemote(readOriginUrl(chosen));
    if (!repo?.slug || !origin || origin === repo.slug) {
      if (!existsSync(chosen)) throw new Error(`The folder chosen for this repo no longer exists: ${chosen}. Change it in Run in Browser.`);
      status('resolving', `Using your chosen folder ${tildify(chosen)}`);
      return report(chosen, 'chosen');
    }
    status('resolving', `Ignoring ${tildify(chosen)} — it's a clone of ${origin}, not ${repo.slug}.`);
  }
  if (!repo?.slug || !repo?.cloneUrl) {
    throw new Error('No repository to start. Open a GitHub/GitLab repo page first.');
  }
  status('resolving', `Looking for a local clone of ${repo.slug}…`);
  const local = findLocalClone(repo.slug, { roots: searchRootsFor({ cloneRoot: msg.cloneRoot, extraRoots: msg.searchRoots }) });
  if (local) {
    status('resolving', `Using your local clone at ${tildify(local)}`);
    return report(local, 'found');
  }
  const { dest, managed } = cloneDestination(repo.slug, msg.cloneRoot, repo.cloneUrl);
  if (!managed) {
    mkdirSync(path.dirname(dest), { recursive: true });
  }
  status('installing', existsSync(dest) ? `Updating ${repo.slug}…` : `No local clone found — cloning ${repo.slug} into ${tildify(dest)}…`);
  const result = await cloneOrUpdate(repo.cloneUrl, dest, { token: msg.token, platform: repo.platform });
  if (result.error) log(`git fetch failed (${result.error}) — using the existing copy`);
  return report(dest, managed ? 'managed' : 'cloned');
};

/** Open the OS folder dialog; reply with the path (and its git origin, so the UI can validate). */
const pickFolder = (msg) => {
  const { cmd, args } = folderPickerCommand(process.platform, msg.prompt || 'Choose a folder');
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let out = '';
  let err = '';
  proc.stdout.on('data', (chunk) => (out += chunk.toString()));
  proc.stderr.on('data', (chunk) => (err += chunk.toString()));
  let replied = false; // 'error' and 'exit' can both fire for a missing binary — reply once
  proc.once('error', () => {
    replied = true;
    fail(`No folder picker is available (${cmd} not found) — type the path instead.`);
  });
  proc.once('exit', (code) => {
    if (replied) return;
    const chosen = out.trim().replace(/[\\/]+$/, '');
    if (code === 0 && chosen) {
      send({ type: 'folderPicked', path: chosen, origin: normalizeRemote(readOriginUrl(chosen)) || undefined });
    } else if (code === 1 || /cancel/i.test(err)) {
      send({ type: 'folderPicked', cancelled: true });
    } else {
      fail(`The folder picker failed${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''} — type the path instead.`);
    }
  });
};

/**
 * Start the databases/queues the API needs from the repo's compose file — only those not
 * already listening locally (reuse whatever the user runs). Never fatal: the API reports a
 * clearer error if its DB is really missing.
 */
const startInfra = async (repoRoot, deadline) => {
  const compose = findComposeFile(repoRoot);
  if (!compose) return;
  const infra = infraServices(parseComposeServices(readFileSync(compose, 'utf8'))).filter((svc) => svc.ports.length);
  const missing = [];
  for (const svc of infra) {
    const open = (await Promise.all(svc.ports.map((p) => isPortOpen(p)))).every(Boolean);
    if (open) component(svc.name, 'running', `Already running on port ${svc.ports.join(', ')} — reusing it.`);
    else missing.push(svc);
  }
  if (!missing.length || shuttingDown) return;
  const names = missing.map((svc) => svc.name);
  try {
    await ensureDocker(repoRoot, deadline);
  } catch (error) {
    for (const svc of missing) {
      component(svc.name, 'failed', `Not running, and Docker isn't available to start it (${error instanceof Error ? error.message : error}). Start it yourself on port ${svc.ports.join(', ')}.`);
    }
    return;
  }
  for (const name of names) component(name, 'starting', 'Starting in Docker…');
  const up = spawnSync('docker', ['compose', '-f', compose, 'up', '-d', ...names], { encoding: 'utf8', timeout: 300_000, env: buildChildEnv() });
  if (up.status !== 0) {
    for (const name of names) component(name, 'failed', `docker compose up failed: ${(up.stderr || '').trim().split('\n').pop() || 'unknown error'}`);
    return;
  }
  startedInfra = { compose, names };
  for (const svc of missing) {
    try {
      await waitForPort(svc.ports[0], () => [], Math.min(deadline, Date.now() + 90_000));
      component(svc.name, 'running', `Started in Docker on port ${svc.ports[0]}.`);
    } catch {
      component(svc.name, 'failed', `Started in Docker but port ${svc.ports[0]} never opened.`);
    }
  }
};

/** Boot the web frontend (if any) next to the API, pointed at it. Never blocks or fails Start. */
const startFrontend = async (repoRoot, apiDir, backendUrl, runLocal, deadline) => {
  const dir = pickFrontendDir(repoRoot, apiDir);
  if (!dir || shuttingDown) return;
  const port = await findFreePort();
  component('frontend', 'starting', `Installing and starting ${tildify(dir)}…`);
  const proc = spawn(resolveBash(), [runLocal, dir, '--port', String(port)], {
    cwd: dir,
    env: { ...buildChildEnv(port), ...frontendEnv(backendUrl) },
    detached: !isWindows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  extraChildren.add(proc);
  const announced = new Set();
  const onOutput = (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const p = portFromLogLine(line);
      if (p) announced.add(p);
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  let running = false;
  proc.once('exit', (code) => {
    extraChildren.delete(proc);
    if (!shuttingDown) component('frontend', running ? 'stopped' : 'failed', `Frontend exited (code ${code ?? 'unknown'}).`);
  });
  try {
    const open = await waitForPort(port, () => [...announced], deadline);
    if (!shuttingDown && extraChildren.has(proc)) {
      running = true;
      component('frontend', 'running', 'Frontend is up.', `http://localhost:${open}`);
    }
  } catch {
    if (!shuttingDown && extraChildren.has(proc)) {
      component('frontend', 'failed', 'Frontend did not start in time.');
      killGroup(proc);
    }
  }
};

const boot = async (msg) => {
  if (child) {
    fail('A service is already running for this session.');
    return;
  }
  // Validate the port rather than silently coercing 0/NaN to 8080 (which would diverge from
  // the port the extension validates against).
  // 0 / absent = auto (a free port, or the compose-published one). Anything else must be valid.
  let port = 0;
  if (msg.port !== undefined && msg.port !== null && msg.port !== '' && Number(msg.port) !== 0) {
    port = Number(msg.port);
    if (!isValidPort(port)) {
      fail(`Invalid port: ${msg.port}`);
      return;
    }
  }
  logCount = 0; // reset per boot so a re-run isn't silenced by a prior run's log cap
  const runLocal = resolveRunLocal(msg.runLocalScriptPath);
  if (!runLocal) {
    fail('Could not locate runLocal/run-local.sh. Set runLocalScriptPath in Settings or APITISER_RUNLOCAL.');
    return;
  }

  const installDeadline = Date.now() + (Number(msg.installTimeoutMs) || 180_000);

  let repoRoot;
  try {
    repoRoot = await resolveSource(msg);
  } catch (error) {
    bootSettled = true;
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (shuttingDown) return;

  // The API folder (from where the scanned routes live). When it's a sub-app of a compose
  // stack, run it natively and start only its databases — not the whole compose build.
  const apiDir = pickApiDir(repoRoot, msg.appDirHint);
  const repoPath = apiDir;
  if (apiDir !== repoRoot) {
    status('resolving', `API found in ${path.relative(repoRoot, apiDir)}/`);
    await startInfra(repoRoot, installDeadline);
  } else {
    // (a) Auto-start Docker for compose/Dockerfile repos so the user needn't start it by hand.
    try {
      await ensureDocker(repoPath, installDeadline);
    } catch (error) {
      bootSettled = true;
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (shuttingDown) return;
  const envSample = ensureEnvFile(apiDir, repoRoot);
  if (envSample) status('resolving', `Created .env from ${path.basename(envSample)} — edit it if the app needs real secrets.`);

  // (b) Auto-detect the app's real port from compose (e.g. 8000) when the caller didn't pass an
  // explicit one. Compose publishes fixed ports, so the requested 8080 is often wrong.
  if (!port) {
    const detected = apiDir === repoRoot ? detectComposePort(repoPath) : undefined;
    if (detected) {
      port = detected;
      diag(`auto-detected compose app port ${port}`);
    } else {
      port = await findFreePort();
      diag(`auto-selected free port ${port}`);
    }
  }
  // Something already listening there would look "ready" instantly and the tests would hit the
  // wrong app. Move to a free port instead (the requested one is unusable either way).
  if (await isPortOpen(port)) {
    const busy = port;
    port = await findFreePort();
    diag(`port ${busy} busy — using free port ${port}`);
    status('resolving', `Port ${busy} is already in use — starting on free port ${port} instead.`);
  }

  status('resolving', `Using runLocal at ${runLocal}`);
  const args = [runLocal, repoPath, '--port', String(port)];
  if (msg.cmd) {
    args.push('--cmd', String(msg.cmd));
  }
  if (msg.stack) {
    args.push('--stack', String(msg.stack));
  }

  const bash = resolveBash();
  const env = buildChildEnv(port);
  // Clear macOS quarantine on any pre-existing repo/node_modules so native build tools
  // (esbuild/vite/swc) aren't blocked by Gatekeeper when the service boots.
  stripQuarantineMac(repoRoot);
  diag(`spawning ${bash} ${args.join(' ')} (PATH=${env.PATH})`);
  status('installing', `Installing dependencies and starting the service…${isWindows ? ' (via ' + bash + ')' : ''}`);
  child = spawn(bash, args, {
    cwd: repoPath, // run inside the repo, not its parent
    env,
    detached: !isWindows, // POSIX process group for clean teardown; Windows uses taskkill /T
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const announcedPorts = new Set();
  const onOutput = (data) => {
    const text = data.toString();
    for (const line of text.split(/\r?\n/)) {
      const announced = portFromLogLine(line);
      if (announced) announcedPorts.add(announced);
    }
    log(text);
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.once('error', (error) => {
    if (!shuttingDown && !bootSettled) {
      bootSettled = true;
      fail(`Failed to start runLocal: ${error.message}`);
    }
  });
  child.once('exit', (code) => {
    child = null;
    if (sigkillTimer) {
      clearTimeout(sigkillTimer); // clean exit → don't fire SIGKILL at a possibly-recycled PID
      sigkillTimer = null;
    }
    // Only report exit-before-ready ONCE. After boot has settled (ready sent, or already
    // failed/timed out), a later exit is expected teardown — don't emit a second error frame.
    if (!shuttingDown && !bootSettled) {
      bootSettled = true;
      status('stopped', `Service process exited (code ${code ?? 'unknown'}).`);
      fail(`The service exited before it became ready (code ${code ?? 'unknown'}).`);
    } else if (!shuttingDown && serviceReady) {
      // Died after ready (crash, or killed outside APItiser): tell the extension so it stops
      // showing "Running" and sending tests at a dead port.
      serviceReady = false;
      status('stopped', `The service stopped unexpectedly (exit code ${code ?? 'unknown'}).`);
    }
  });

  status('waiting', `Waiting for the service on port ${port}…`);
  const deadline = Date.now() + (Number(msg.installTimeoutMs) || 180_000);
  try {
    const openPort = await waitForPort(port, () => [...announcedPorts], deadline);
    if (!shuttingDown && !bootSettled) {
      bootSettled = true;
      serviceReady = true;
      if (openPort !== port) {
        status('waiting', `The app ignored PORT=${port} and is listening on ${openPort} — using that.`);
      }
      send({ type: 'ready', port: openPort, baseUrl: `http://localhost:${openPort}` });
      if (msg.withFrontend !== false) {
        void startFrontend(repoRoot, apiDir, `http://localhost:${openPort}`, runLocal, Date.now() + 600_000);
      }
    }
  } catch (error) {
    if (!shuttingDown && !bootSettled) {
      bootSettled = true;
      fail(`Service did not become ready: ${error instanceof Error ? error.message : String(error)}`);
      killChild();
    }
  }
};

// --- run the repo's OWN existing test suite ----------------------------------
const detectTestCommand = (repoPath) => {
  const has = (file) => existsSync(path.join(repoPath, file));
  const readText = (file) => {
    try {
      return readFileSync(path.join(repoPath, file), 'utf8');
    } catch {
      return '';
    }
  };
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readText('package.json'));
      if (pkg?.scripts?.test) return 'npm test --silent';
    } catch {
      /* fall through */
    }
  }
  if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('conftest.py') || has('requirements.txt') || has('tests')) {
    return 'pytest -q';
  }
  if (has('go.mod')) return 'go test ./...';
  if (has('pom.xml')) return 'mvn -q test';
  if (has('build.gradle') || has('build.gradle.kts')) return has('gradlew') ? './gradlew test' : 'gradle test';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('Makefile') && /^test:/m.test(readText('Makefile'))) return 'make test';
  return '';
};

const firstExisting = (repoPath, files) => files.find((f) => existsSync(path.join(repoPath, f)));

/**
 * (c) Wrap an auto-detected test command with the dependency setup the repo needs, so the user
 * doesn't have to prepare an env. Skipped when the user gave an explicit Test Command Override.
 *  - pytest → create a fresh venv on a compatible Python (≥3.11) + pip install requirements,
 *    then run via that venv (fixes "broken venv / wrong Python / missing deps").
 *  - npm    → npm ci/install first.  - go → go mod download first.
 */
const autoPrepareTestCmd = (repoPath, baseCmd) => {
  const venvPy = isWindows ? '.apitiser-venv/Scripts/python' : '.apitiser-venv/bin/python';
  if (/^pytest\b/.test(baseCmd)) {
    // Prefer the LIGHTEST requirements that still carries test deps — a full requirements.txt
    // often pulls a heavy/ML stack (and can be unresolvable). dev/test/base first.
    const req = firstExisting(repoPath, [
      'requirements-test.txt',
      'requirements-dev.txt',
      'requirements-base.txt',
      'requirements.txt',
      'backend/requirements-test.txt',
      'backend/requirements-dev.txt',
      'backend/requirements-base.txt',
      'backend/requirements.txt'
    ]);
    const py = pickPython();
    const reqInstall = req ? ` -r ${req}` : '';
    return `"${py}" -m venv .apitiser-venv 2>/dev/null || true; ${venvPy} -m pip install -q --disable-pip-version-check pytest${reqInstall} && ${venvPy} -m ${baseCmd}`;
  }
  if (/^npm\b/.test(baseCmd)) {
    // After install, clear macOS quarantine on node_modules so native test tooling
    // (esbuild/vite/swc) isn't blocked by Gatekeeper. No-op / ignored elsewhere.
    const deQuarantine = isMac ? ' && (xattr -dr com.apple.quarantine node_modules 2>/dev/null || true)' : '';
    return `(npm ci || npm install)${deQuarantine} && ${baseCmd}`;
  }
  if (/^go test\b/.test(baseCmd)) {
    return `go mod download && ${baseCmd}`;
  }
  return baseCmd;
};

const runTests = (msg) => {
  if (child) {
    fail('A run is already in progress.');
    return;
  }
  const repoPath = String(msg.repoPath || '').trim();
  if (!repoPath || !existsSync(repoPath)) {
    fail(`Repo path not found: ${repoPath || '(empty)'}`);
    return;
  }
  const override = msg.testCmd && String(msg.testCmd).trim();
  const detected = override || detectTestCommand(repoPath);
  if (!detected) {
    fail('Could not detect a test command for this repo. Set a Test Command Override in Settings.');
    return;
  }
  // Auto-prepare deps only for an auto-detected command; an explicit override runs verbatim.
  const testCmd = override ? detected : autoPrepareTestCmd(repoPath, detected);
  logCount = 0;
  const bash = resolveBash();
  const env = buildChildEnv(msg.port);
  if (msg.port) {
    env.API_BASE_URL = `http://localhost:${msg.port}`;
  }
  diag(`running tests: ${bash} -c "${testCmd}" (cwd=${repoPath})`);
  status('testing', `Running repo tests: ${testCmd}`);
  const startedAt = Date.now();
  child = spawn(bash, ['-c', testCmd], {
    cwd: repoPath,
    env,
    detached: !isWindows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (data) => log(data.toString()));
  child.stderr.on('data', (data) => log(data.toString()));
  child.once('error', (error) => {
    if (!shuttingDown) {
      fail(`Failed to run tests: ${error.message}`);
    }
  });
  child.once('exit', (code) => {
    child = null;
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = null;
    }
    if (!shuttingDown) {
      send({ type: 'testsComplete', exitCode: code ?? 1, command: testCmd, durationMs: Date.now() - startedAt });
    }
  });
  const timeoutMs = Number(msg.testTimeoutMs) || 600_000;
  setTimeout(() => {
    if (child) {
      diag(`test run exceeded ${timeoutMs}ms — killing`);
      killChild();
    }
  }, timeoutMs);
};

// --- run an APItiser-GENERATED suite via its own framework runner ------------
// Writes the generated files to a scratch dir, runs `<installCmd> && <testCmd>`, reports exit.
const runSuite = (msg) => {
  if (child) {
    fail('A run is already in progress.');
    return;
  }
  const files = Array.isArray(msg.files) ? msg.files : [];
  const testCmd = String(msg.testCmd || '').trim();
  if (!files.length || !testCmd) {
    fail('No generated suite files or test command to run.');
    return;
  }
  const dir = String(msg.dir || '').trim() || path.join(os.homedir(), '.apitiser', 'suites', 'current');
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      // Reject any path that escapes the suite directory (a `../` in a generated file path).
      if (!isPathInsideDir(dir, String(file.path))) {
        fail(`Refusing to write outside the suite directory: ${String(file.path)}`);
        return;
      }
      const dest = path.resolve(dir, String(file.path));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, String(file.content ?? ''), file.exec ? { mode: 0o755 } : undefined);
    }
  } catch (error) {
    fail(`Failed to write generated suite: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  logCount = 0;
  const bash = resolveBash();
  const env = buildChildEnv(msg.port);
  if (msg.port) {
    env.API_BASE_URL = `http://localhost:${msg.port}`;
  }
  const full = msg.installCmd ? `${String(msg.installCmd)} && ${testCmd}` : testCmd;
  diag(`running generated suite in ${dir}: ${full}`);
  status('testing', 'Installing & running the generated suite…');
  const startedAt = Date.now();
  child = spawn(bash, ['-c', full], {
    cwd: dir,
    env,
    detached: !isWindows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (data) => log(data.toString()));
  child.stderr.on('data', (data) => log(data.toString()));
  child.once('error', (error) => {
    if (!shuttingDown) {
      fail(`Failed to run generated suite: ${error.message}`);
    }
  });
  child.once('exit', (code) => {
    child = null;
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = null;
    }
    if (!shuttingDown) {
      send({ type: 'testsComplete', exitCode: code ?? 1, command: testCmd, durationMs: Date.now() - startedAt });
    }
  });
  const timeoutMs = Number(msg.testTimeoutMs) || 600_000;
  setTimeout(() => {
    if (child) {
      diag(`generated-suite run exceeded ${timeoutMs}ms — killing`);
      killChild();
    }
  }, timeoutMs);
};

const shutdown = () => {
  shuttingDown = true;
  killChild();
  for (const proc of extraChildren) killGroup(proc);
  stopInfra();
  setTimeout(() => process.exit(0), 200);
};

/** Run a request handler; send its result, or its error message. */
const reply = (produce) => {
  try {
    send(produce());
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};

const handle = (msg) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }
  diag(`recv message type=${msg.type}`);
  if (msg.type === 'boot') {
    boot(msg).catch((error) => fail(error instanceof Error ? error.message : String(error)));
  } else if (msg.type === 'runTests') {
    runTests(msg);
  } else if (msg.type === 'runSuite') {
    runSuite(msg);
  } else if (msg.type === 'shutdown') {
    shutdown();
  } else if (msg.type === 'readFiles') {
    reply(() => ({ type: 'files', files: readRepoFiles(expandHome(msg.root), msg.paths ?? []) }));
  } else if (msg.type === 'applyEdits') {
    reply(() => ({ type: 'editsApplied', ...applyEdits(expandHome(msg.root), msg.edits, { allowedPaths: msg.allowedPaths }) }));
  } else if (msg.type === 'restoreBackup') {
    reply(() => ({ type: 'restored', ...restoreBackup(msg.backupId) }));
  } else if (msg.type === 'pickFolder') {
    pickFolder(msg);
  } else if (msg.type === 'ping') {
    send({ type: 'pong' });
  }
};

// --- stdin frame reader -------------------------------------------------------
let buffer = Buffer.alloc(0);
const onStdinData = (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const { messages, rest, error } = decodeFrames(buffer, MAX_FRAME_BYTES);
  buffer = rest;
  if (error === 'oversized') {
    // A bogus/oversized length would otherwise make us buffer forever. decodeFrames already
    // reset the remainder; surface the error.
    diag('oversized frame — resetting buffer');
    fail('Received an oversized message frame.');
  } else if (error === 'malformed') {
    fail('Received malformed message frame.');
  }
  for (const message of messages) {
    handle(message);
  }
};

if (isMain) {
  process.stdin.on('error', (error) => diag(`stdin error: ${error.message}`));
  process.stdin.resume();
  process.stdin.on('data', onStdinData);
  // When Chrome disconnects the port, stdin ends → tear down the service.
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Surface unexpected host failures to the extension instead of dying silently (which would
// look like an indefinite "Starting local service…" hang).
if (isMain) {
  process.on('uncaughtException', (error) => {
    diag(`uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    try {
      fail(`Host error: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      /* stdout may be gone */
    }
  });
  process.on('unhandledRejection', (reason) => {
    diag(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
}
