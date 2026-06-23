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

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_LINES = 400;

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

const waitForPort = (port, host, deadline) =>
  new Promise((resolve, reject) => {
    const attempt = () => {
      if (shuttingDown) {
        reject(new Error('shutting down'));
        return;
      }
      const socket = net.createConnection({ port, host });
      socket.setTimeout(1500);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${port} did not open before timeout`));
        } else {
          setTimeout(attempt, 500);
        }
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
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

const boot = async (msg) => {
  if (child) {
    fail('A service is already running for this session.');
    return;
  }
  // Validate the port rather than silently coercing 0/NaN to 8080 (which would diverge from
  // the port the extension validates against).
  let port = 8080;
  if (msg.port !== undefined && msg.port !== null && msg.port !== '') {
    port = Number(msg.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail(`Invalid port: ${msg.port}`);
      return;
    }
  }
  logCount = 0; // reset per boot so a re-run isn't silenced by a prior run's log cap
  const repoPath = String(msg.repoPath || '').trim();
  if (!repoPath || !existsSync(repoPath)) {
    fail(`Repo path not found: ${repoPath || '(empty)'}`);
    return;
  }
  const runLocal = resolveRunLocal(msg.runLocalScriptPath);
  if (!runLocal) {
    fail('Could not locate runLocal/run-local.sh. Set runLocalScriptPath in Settings or APITISER_RUNLOCAL.');
    return;
  }

  const installDeadline = Date.now() + (Number(msg.installTimeoutMs) || 180_000);

  // (a) Auto-start Docker for compose/Dockerfile repos so the user needn't start it by hand.
  try {
    await ensureDocker(repoPath, installDeadline);
  } catch (error) {
    bootSettled = true;
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (shuttingDown) {
    return;
  }

  // (b) Auto-detect the app's real port from compose (e.g. 8000) when the caller didn't pass an
  // explicit one. Compose publishes fixed ports, so the requested 8080 is often wrong.
  const explicitPort = msg.port !== undefined && msg.port !== null && msg.port !== '';
  if (!explicitPort) {
    const detected = detectComposePort(repoPath);
    if (detected) {
      port = detected;
      diag(`auto-detected compose app port ${port}`);
    }
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
  diag(`spawning ${bash} ${args.join(' ')} (PATH=${env.PATH})`);
  status('installing', `Installing dependencies and starting the service…${isWindows ? ' (via ' + bash + ')' : ''}`);
  child = spawn(bash, args, {
    cwd: repoPath, // run inside the repo, not its parent
    env,
    detached: !isWindows, // POSIX process group for clean teardown; Windows uses taskkill /T
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => log(data.toString()));
  child.stderr.on('data', (data) => log(data.toString()));
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
    }
  });

  status('waiting', `Waiting for the service on port ${port}…`);
  const deadline = Date.now() + (Number(msg.installTimeoutMs) || 180_000);
  try {
    await waitForPort(port, '127.0.0.1', deadline);
    if (!shuttingDown && !bootSettled) {
      bootSettled = true;
      send({ type: 'ready', port, baseUrl: `http://localhost:${port}` });
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
    return `(npm ci || npm install) && ${baseCmd}`;
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
      const dest = path.join(dir, String(file.path));
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
  setTimeout(() => process.exit(0), 200);
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
  } else if (msg.type === 'ping') {
    send({ type: 'pong' });
  }
};

// --- stdin frame reader -------------------------------------------------------
let buffer = Buffer.alloc(0);
process.stdin.on('error', (error) => diag(`stdin error: ${error.message}`));
process.stdin.resume();
const MAX_FRAME_BYTES = 1024 * 1024; // Chrome caps native-messaging frames at 1 MB
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > MAX_FRAME_BYTES) {
      // A bogus/oversized length would otherwise make us buffer forever waiting for bytes that
      // never arrive. Reject and reset rather than grow memory unbounded.
      diag(`oversized frame length=${length} — resetting buffer`);
      fail('Received an oversized message frame.');
      buffer = Buffer.alloc(0);
      break;
    }
    if (buffer.length < 4 + length) {
      break;
    }
    const body = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    try {
      handle(JSON.parse(body.toString('utf8')));
    } catch {
      fail('Received malformed message frame.');
    }
  }
});

// When Chrome disconnects the port, stdin ends → tear down the service.
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Surface unexpected host failures to the extension instead of dying silently (which would
// look like an indefinite "Starting local service…" hang).
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
