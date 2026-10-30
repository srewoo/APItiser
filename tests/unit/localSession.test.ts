import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRunningService,
  resetLocalSessionForTests,
  staleServiceState,
  startLocalService,
  stopLocalService,
  friendlyBootError
} from '@background/runner/localSession';
import { RUNNER_NOT_INSTALLED } from '@shared/messages';
import { bootRepoService } from '@background/runner/localRunner';
import { createFakePlatform } from '@shared/platform/testDoubles/fakePlatform';
import type { LocalServiceState } from '@shared/types';

afterEach(() => resetLocalSessionForTests());

const boot = async () => {
  const platform = createFakePlatform();
  const states: LocalServiceState[] = [];
  const publish = vi.fn(async (state: LocalServiceState) => {
    states.push(state);
  });
  const promise = startLocalService(platform.native, { repoPath: '/repo', port: 8080 }, publish);
  const port = platform._nativePorts[0];
  port.emit({ type: 'status', phase: 'installing', message: 'npm ci' });
  port.emit({ type: 'ready', port: 8080, baseUrl: 'http://localhost:8080' });
  const handle = await promise;
  return { platform, port, states, publish, handle };
};

describe('local service session', () => {
  it('publishes starting → running and keeps the handle', async () => {
    const { states, handle } = await boot();
    expect(states.map((state) => state.status)).toEqual(['starting', 'starting', 'running']);
    expect(states.at(-1)).toMatchObject({ baseUrl: 'http://localhost:8080', port: 8080 });
    expect(getRunningService()).toBe(handle);
  });

  it('reuses the running service instead of booting a second one', async () => {
    const { platform, handle } = await boot();
    const again = await startLocalService(platform.native, { repoPath: '/repo', port: 8080 }, vi.fn());
    expect(again).toBe(handle);
    expect(platform._nativePorts).toHaveLength(1);
  });

  it('marks the service failed when it dies unexpectedly', async () => {
    const { port, states } = await boot();
    port.fireDisconnect({ message: 'process exited' });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('error'));
    expect(states.at(-1)?.message).toBe('process exited');
    expect(getRunningService()).toBeNull();
  });

  it('stops on request without reporting an unexpected exit', async () => {
    const { port, states } = await boot();
    const publish = vi.fn(async (state: LocalServiceState) => {
      states.push(state);
    });
    await stopLocalService(publish);
    port.fireDisconnect();
    expect(port.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(states.at(-1)?.status).toBe('stopped');
    expect(states.filter((state) => state.status === 'error')).toHaveLength(0);
    expect(getRunningService()).toBeNull();
  });

  it('publishes an error and rethrows when boot fails', async () => {
    const platform = createFakePlatform();
    const states: LocalServiceState[] = [];
    const promise = startLocalService(platform.native, { repoPath: '/repo', port: 8080 }, async (state) => {
      states.push(state);
    });
    platform._nativePorts[0].emit({ type: 'error', message: 'runLocal not found' });
    await expect(promise).rejects.toThrow(/runLocal not found/);
    expect(states.at(-1)).toMatchObject({ status: 'error', message: 'runLocal not found' });
  });

  it('flags a persisted running status as stale when no handle exists', () => {
    expect(staleServiceState({ status: 'running', port: 1, updatedAt: 0 })?.status).toBe('stopped');
    expect(staleServiceState({ status: 'stopped', updatedAt: 0 })).toBeNull();
    expect(staleServiceState(undefined)).toBeNull();
  });
});

describe('bootRepoService onExit', () => {
  it('fires once when the host reports the service stopped after ready', async () => {
    const platform = createFakePlatform();
    const onExit = vi.fn();
    const promise = bootRepoService(platform.native, { repoPath: '/r', port: 1, onExit });
    const port = platform._nativePorts[0];
    port.emit({ type: 'ready', port: 1, baseUrl: 'http://localhost:1' });
    await promise;
    port.emit({ type: 'status', phase: 'stopped', message: 'service exited (code 1)' });
    port.fireDisconnect();
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith('service exited (code 1)');
  });
});

describe('stack components and install guidance', () => {
  it('carries database/frontend progress into every published state, before and after ready', async () => {
    const platform = createFakePlatform();
    const states: LocalServiceState[] = [];
    const promise = startLocalService(platform.native, { repo: { slug: 'github.com/a/b', cloneUrl: 'https://github.com/a/b.git', platform: 'github' }, port: 0 }, async (state) => {
      states.push(state);
    });
    const port = platform._nativePorts[0];
    expect(port.posted[0]).toMatchObject({ type: 'boot', repo: { slug: 'github.com/a/b' }, port: 0 });
    port.emit({ type: 'component', name: 'mongo', status: 'running', message: 'reused' });
    port.emit({ type: 'ready', port: 41000, baseUrl: 'http://localhost:41000' });
    await promise;
    port.emit({ type: 'component', name: 'frontend', status: 'running', url: 'http://localhost:41001' });
    await vi.waitFor(() => expect(states.at(-1)?.components).toHaveLength(2));

    const last = states.at(-1)!;
    expect(last.status).toBe('running'); // a frontend update doesn't change the API's state
    expect(last.components).toEqual([
      { name: 'mongo', status: 'running', message: 'reused' },
      { name: 'frontend', status: 'running', url: 'http://localhost:41001' }
    ]);
  });

  it('turns "native host not found" into install guidance', async () => {
    const platform = createFakePlatform();
    const states: LocalServiceState[] = [];
    const promise = startLocalService(platform.native, { repoPath: '/r', port: 0 }, async (state) => {
      states.push(state);
    });
    platform._nativePorts[0].fireDisconnect({ message: 'Specified native messaging host not found.' });
    await expect(promise).rejects.toThrow(RUNNER_NOT_INSTALLED);
    expect(states.at(-1)).toMatchObject({ status: 'error', message: RUNNER_NOT_INSTALLED });
    expect(friendlyBootError(new Error('port 99 did not open'))).toBe('port 99 did not open');
  });
});
