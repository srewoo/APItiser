/**
 * Local-runner bridge.
 *
 * Drives the APItiser native messaging host, which wraps `runLocal` to clone/install/boot a
 * repo as a local service. The extension cannot spawn processes (MV3 sandbox), so this is the
 * only path to "boot the service" without a hosted backend — Chrome launches the host on
 * demand and we talk to it over a native-messaging port. Once the host reports the service is
 * ready, the caller points the existing in-browser validator at http://localhost:<port>.
 *
 * This module is pure logic over a NativeMessagingAdapter, so it is unit-tested with the
 * in-memory FakeNativePort rather than a real host.
 */
import type { NativeMessagingAdapter } from '@shared/platform';

export const DEFAULT_NATIVE_HOST = 'com.apitiser.localrunner';

export interface SuiteFile {
  path: string;
  content: string;
  exec?: boolean;
}

/** extension → host */
export type HostCommand =
  | { type: 'boot'; repoPath: string; port: number; runLocalScriptPath?: string; cmd?: string; stack?: string; installTimeoutMs?: number }
  | { type: 'runTests'; repoPath: string; testCmd?: string; port?: number; testTimeoutMs?: number }
  | { type: 'runSuite'; files: SuiteFile[]; installCmd?: string; testCmd: string; port?: number; dir?: string; testTimeoutMs?: number }
  | { type: 'shutdown' }
  | { type: 'ping' };

export type BootPhase = 'resolving' | 'installing' | 'starting' | 'waiting' | 'ready' | 'stopped' | 'testing' | 'error';

/** host → extension */
export type HostEvent =
  | { type: 'status'; phase: BootPhase; message?: string }
  | { type: 'log'; line: string }
  | { type: 'ready'; port: number; baseUrl: string }
  | { type: 'testsComplete'; exitCode: number; command?: string; durationMs?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface LocalRunOptions {
  hostName?: string;
  repoPath: string;
  port: number;
  /** Absolute path to run-local.sh; the host falls back to its bundled copy when omitted. */
  runLocalScriptPath?: string;
  /** Override the run command / stack passed to runLocal. */
  cmd?: string;
  stack?: string;
  /** Total time to allow for install + boot before giving up. Default 180s. */
  bootTimeoutMs?: number;
  onStatus?: (phase: BootPhase, message?: string) => void;
  onLog?: (line: string) => void;
}

export interface LocalRunHandle {
  port: number;
  baseUrl: string;
  /** Tell the host to stop the service and disconnect. Idempotent. */
  stop(): void;
}

export interface HostPingResult {
  ok: boolean;
  message?: string;
}

/**
 * Verify the native host is installed and launchable: connect, send `ping`, expect `pong`.
 * Never rejects — resolves `{ ok, message }` so callers can render a status without try/catch.
 * This is the cheap preflight behind the Settings "Check setup" button.
 */
export const pingHost = (
  native: NativeMessagingAdapter,
  options?: { hostName?: string; timeoutMs?: number }
): Promise<HostPingResult> =>
  new Promise<HostPingResult>((resolve) => {
    if (!native.isAvailable()) {
      resolve({ ok: false, message: 'Native messaging is unavailable in this context.' });
      return;
    }
    let port: ReturnType<NativeMessagingAdapter['connect']>;
    try {
      port = native.connect(options?.hostName ?? DEFAULT_NATIVE_HOST);
    } catch (error) {
      resolve({ ok: false, message: error instanceof Error ? error.message : 'Failed to connect to the host.' });
      return;
    }
    let settled = false;
    const finish = (result: HostPingResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, message: 'Host did not respond (timed out).' }), options?.timeoutMs ?? 5000);
    port.onMessage((raw) => {
      if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'pong') {
        finish({ ok: true });
      }
    });
    port.onDisconnect((error) =>
      finish({ ok: false, message: error?.message ?? 'Native host disconnected (is it installed for this extension ID?).' })
    );
    try {
      port.postMessage({ type: 'ping' } satisfies HostCommand);
    } catch (error) {
      finish({ ok: false, message: error instanceof Error ? error.message : 'Failed to message the host.' });
    }
  });

export interface RepoTestResult {
  exitCode: number;
  passed: boolean;
  command?: string;
  durationMs?: number;
}

export interface RunRepoTestsOptions {
  hostName?: string;
  repoPath: string;
  /** Test command to run; the host auto-detects (pytest/npm test/go test/…) when omitted. */
  testCmd?: string;
  /** Forwarded as PORT / API_BASE_URL to the test process. */
  port?: number;
  /** Max time to allow the test run. Default 600s. */
  timeoutMs?: number;
  onStatus?: (phase: BootPhase, message?: string) => void;
  onLog?: (line: string) => void;
}

/**
 * Shared machinery for any command that ends in a `testsComplete` frame (runTests / runSuite):
 * connect, post the command, stream status/log, resolve with the exit code (0 = passed).
 * Never resolves twice; cleans up its timer and listeners; rejects on error/disconnect/timeout.
 */
const awaitTestRun = (
  native: NativeMessagingAdapter,
  command: HostCommand,
  options: { hostName?: string; timeoutMs?: number; onStatus?: (phase: BootPhase, message?: string) => void; onLog?: (line: string) => void; label: string }
): Promise<RepoTestResult> =>
  new Promise<RepoTestResult>((resolve, reject) => {
    if (!native.isAvailable()) {
      reject(new Error('Native messaging is unavailable. Install the APItiser local runner host (see docs).'));
      return;
    }
    const port = native.connect(options.hostName ?? DEFAULT_NATIVE_HOST);
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 600_000;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        port.postMessage({ type: 'shutdown' } satisfies HostCommand);
      } catch {
        /* gone */
      }
      port.disconnect();
      reject(new Error(`Timed out after ${timeoutMs / 1000}s ${options.label}.`));
    }, timeoutMs);

    port.onMessage((raw) => {
      if (!isHostEvent(raw) || settled) {
        return;
      }
      if (raw.type === 'log') {
        options.onLog?.(raw.line);
      } else if (raw.type === 'status') {
        options.onStatus?.(raw.phase, raw.message);
      } else if (raw.type === 'testsComplete') {
        settled = true;
        clearTimeout(timeout);
        port.disconnect();
        resolve({ exitCode: raw.exitCode, passed: raw.exitCode === 0, command: raw.command, durationMs: raw.durationMs });
      } else if (raw.type === 'error') {
        settled = true;
        clearTimeout(timeout);
        port.disconnect();
        reject(new Error(raw.message || 'The local runner host reported an error.'));
      }
    });
    port.onDisconnect((error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error(error?.message ?? 'The local runner host disconnected before the run finished.'));
    });

    port.postMessage(command);
  });

/**
 * Run the repo's OWN existing test suite locally via the native host. Resolves with its exit
 * code (0 = passed).
 */
export const runRepoTests = (native: NativeMessagingAdapter, options: RunRepoTestsOptions): Promise<RepoTestResult> => {
  const timeoutMs = options.timeoutMs ?? 600_000;
  return awaitTestRun(
    native,
    { type: 'runTests', repoPath: options.repoPath, testCmd: options.testCmd, port: options.port, testTimeoutMs: timeoutMs },
    { hostName: options.hostName, timeoutMs, onStatus: options.onStatus, onLog: options.onLog, label: 'running repo tests' }
  );
};

export interface RunGeneratedSuiteOptions {
  hostName?: string;
  files: SuiteFile[];
  /** Framework install + test commands (e.g. install `npm install`, test `npx jest tests`). */
  installCmd?: string;
  testCmd: string;
  port?: number;
  dir?: string;
  timeoutMs?: number;
  onStatus?: (phase: BootPhase, message?: string) => void;
  onLog?: (line: string) => void;
}

/**
 * Run an APItiser-GENERATED suite via its own framework runner (jest/pytest/…). The host writes
 * the files to a scratch dir, installs deps, runs the tests, and reports the exit code.
 */
export const runGeneratedSuite = (native: NativeMessagingAdapter, options: RunGeneratedSuiteOptions): Promise<RepoTestResult> => {
  const timeoutMs = options.timeoutMs ?? 600_000;
  return awaitTestRun(
    native,
    { type: 'runSuite', files: options.files, installCmd: options.installCmd, testCmd: options.testCmd, port: options.port, dir: options.dir, testTimeoutMs: timeoutMs },
    { hostName: options.hostName, timeoutMs, onStatus: options.onStatus, onLog: options.onLog, label: 'running the generated suite' }
  );
};

const isHostEvent = (value: unknown): value is HostEvent =>
  Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';

/**
 * Boot a repo's service via the native host, resolving once it reports `ready`. Rejects on
 * host error, disconnect-before-ready, or timeout. The returned handle's `stop()` tears the
 * service down.
 */
export const bootRepoService = (
  native: NativeMessagingAdapter,
  options: LocalRunOptions
): Promise<LocalRunHandle> =>
  new Promise<LocalRunHandle>((resolve, reject) => {
    if (!native.isAvailable()) {
      reject(new Error('Native messaging is unavailable. Install the APItiser local runner host (see docs).'));
      return;
    }

    const port = native.connect(options.hostName ?? DEFAULT_NATIVE_HOST);
    let settled = false;

    const stop = (): void => {
      try {
        port.postMessage({ type: 'shutdown' } satisfies HostCommand);
      } catch {
        // Port may already be gone; disconnect regardless.
      }
      port.disconnect();
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      stop();
      reject(new Error(`Timed out after ${(options.bootTimeoutMs ?? 180_000) / 1000}s waiting for the local service to start.`));
    }, options.bootTimeoutMs ?? 180_000);

    port.onMessage((raw) => {
      if (!isHostEvent(raw) || settled) {
        return;
      }
      if (raw.type === 'log') {
        options.onLog?.(raw.line);
        return;
      }
      if (raw.type === 'status') {
        options.onStatus?.(raw.phase, raw.message);
        return;
      }
      if (raw.type === 'ready') {
        settled = true;
        clearTimeout(timeout);
        options.onStatus?.('ready', `Service ready on port ${raw.port}`);
        resolve({ port: raw.port, baseUrl: raw.baseUrl, stop });
        return;
      }
      if (raw.type === 'error') {
        settled = true;
        clearTimeout(timeout);
        port.disconnect();
        reject(new Error(raw.message || 'The local runner host reported an error.'));
      }
    });

    port.onDisconnect((error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error(error?.message ?? 'The local runner host disconnected before the service was ready.'));
    });

    port.postMessage({
      type: 'boot',
      repoPath: options.repoPath,
      port: options.port,
      runLocalScriptPath: options.runLocalScriptPath,
      cmd: options.cmd,
      stack: options.stack,
      installTimeoutMs: options.bootTimeoutMs
    } satisfies HostCommand);
  });
