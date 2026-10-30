/**
 * Long-lived local service session.
 *
 * `RUN_LOCALLY` boots a service, runs the suite, and tears it down. For clicking through
 * endpoints one at a time the service has to stay up between runs, so this module owns a single
 * extension-wide handle (one service ⇒ one port). The handle lives in service-worker memory; the
 * native port dies with the worker, so the host tears the service down too — callers reset any
 * persisted "running" status on worker start (see `staleServiceState`).
 */
import type { NativeMessagingAdapter } from '@shared/platform';
import type { CodeSource, LocalServiceState, StackComponent } from '@shared/types';
import { RUNNER_NOT_INSTALLED } from '@shared/messages';
import { bootRepoService, type LocalRunHandle, type LocalRunOptions } from './localRunner';

export type PublishServiceState = (state: LocalServiceState) => Promise<void>;

let handle: LocalRunHandle | null = null;
let booting = false;

export const getRunningService = (): LocalRunHandle | null => handle;

export const startLocalService = async (
  native: NativeMessagingAdapter,
  options: Omit<LocalRunOptions, 'onStatus' | 'onLog' | 'onExit' | 'onComponent' | 'onSource'>,
  publish: PublishServiceState
): Promise<LocalRunHandle> => {
  if (handle) {
    return handle;
  }
  if (booting) {
    throw new Error('The local service is already starting.');
  }
  booting = true;

  // Serialize writes so a late boot-status update can never overwrite "running"/"error".
  // Every write carries the latest component list (databases, frontend) alongside the API state.
  let chain: Promise<void> = Promise.resolve();
  const components = new Map<string, StackComponent>();
  let source: CodeSource | undefined;
  let last: Omit<LocalServiceState, 'updatedAt' | 'components' | 'source'> = { status: 'starting' };
  const push = (state: Omit<LocalServiceState, 'updatedAt' | 'components' | 'source'>): Promise<void> => {
    last = state;
    const snapshot = { ...state, components: [...components.values()], source, repoSlug: options.repo?.slug, updatedAt: Date.now() };
    chain = chain.then(() => publish(snapshot)).catch(() => undefined);
    return chain;
  };
  let lastLogAt = 0;
  let mine: LocalRunHandle | null = null;

  void push({
    status: 'starting',
    port: options.port || undefined,
    message: options.port ? `Starting local service on port ${options.port}…` : 'Starting local service on a free port…'
  });
  try {
    mine = await bootRepoService(native, {
      ...options,
      onStatus: (phase, message) => {
        if (phase !== 'ready') void push({ status: 'starting', port: options.port || undefined, message: message ?? phase });
      },
      onLog: (line) => {
        const now = Date.now();
        if (now - lastLogAt > 1500) {
          lastLogAt = now;
          void push({ status: 'starting', port: options.port || undefined, message: line.slice(0, 120) });
        }
      },
      onExit: (message) => {
        if (handle && handle === mine) {
          handle = null;
          void push({ status: 'error', port: options.port, message });
        }
      },
      onComponent: (component) => {
        components.set(component.name, component);
        void push(last);
      },
      onSource: (found) => {
        source = found;
        void push(last);
      }
    });
    handle = mine;
    await push({ status: 'running', port: mine.port, baseUrl: mine.baseUrl, message: `Running on ${mine.baseUrl}` });
    return mine;
  } catch (error) {
    const message = friendlyBootError(error);
    await push({ status: 'error', port: options.port, message });
    throw new Error(message);
  } finally {
    booting = false;
  }
};

/** Chrome's errors for a missing/unregistered native host are cryptic; say what to do instead. */
export const friendlyBootError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'The local service failed to start.';
  return /native messaging host not found|native messaging is unavailable|specified native messaging host|native host has exited|forbidden/i.test(message)
    ? RUNNER_NOT_INSTALLED
    : message;
};

export const stopLocalService = async (publish: PublishServiceState): Promise<void> => {
  const current = handle;
  handle = null;
  current?.stop();
  await publish({ status: 'stopped', port: current?.port, message: 'Local service stopped.', updatedAt: Date.now() });
};

/** A persisted status that claims a live service no longer matches reality after a worker restart. */
export const staleServiceState = (state?: LocalServiceState): LocalServiceState | null =>
  state && (state.status === 'running' || state.status === 'starting') && !handle
    ? { status: 'stopped', port: state.port, message: 'Service stopped when the extension restarted.', updatedAt: Date.now() }
    : null;

/** Test hook: forget any in-memory handle. */
export const resetLocalSessionForTests = (): void => {
  handle = null;
  booting = false;
};
