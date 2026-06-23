import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootRepoService, pingHost, runRepoTests, DEFAULT_NATIVE_HOST } from '@background/runner/localRunner';
import { createFakePlatform } from '@shared/platform/testDoubles/fakePlatform';

afterEach(() => vi.useRealTimers());

describe('bootRepoService', () => {
  it('posts a boot command and resolves with the base URL on ready', async () => {
    const platform = createFakePlatform();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080 });

    const port = platform._nativePorts[0];
    expect(port).toBeDefined();
    expect(port.posted[0]).toMatchObject({ type: 'boot', repoPath: '/repo', port: 8080 });

    port.emit({ type: 'ready', port: 8080, baseUrl: 'http://localhost:8080' });
    const handle = await promise;
    expect(handle.baseUrl).toBe('http://localhost:8080');
    expect(handle.port).toBe(8080);
  });

  it('uses the default host name when none is supplied', async () => {
    const platform = createFakePlatform();
    const connectSpy = vi.spyOn(platform.native, 'connect');
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 3000 });
    platform._nativePorts[0].emit({ type: 'ready', port: 3000, baseUrl: 'http://localhost:3000' });
    await promise;
    expect(connectSpy).toHaveBeenCalledWith(DEFAULT_NATIVE_HOST);
  });

  it('forwards status and log events to callbacks', async () => {
    const platform = createFakePlatform();
    const onStatus = vi.fn();
    const onLog = vi.fn();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080, onStatus, onLog });
    const port = platform._nativePorts[0];
    port.emit({ type: 'status', phase: 'installing', message: 'npm ci' });
    port.emit({ type: 'log', line: 'added 200 packages' });
    port.emit({ type: 'ready', port: 8080, baseUrl: 'http://localhost:8080' });
    await promise;
    expect(onStatus).toHaveBeenCalledWith('installing', 'npm ci');
    expect(onLog).toHaveBeenCalledWith('added 200 packages');
  });

  it('rejects when native messaging is unavailable', async () => {
    const platform = createFakePlatform();
    platform._nativeAvailable = false;
    await expect(bootRepoService(platform.native, { repoPath: '/repo', port: 8080 })).rejects.toThrow(/Native messaging is unavailable/);
  });

  it('rejects on a host error event', async () => {
    const platform = createFakePlatform();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080 });
    platform._nativePorts[0].emit({ type: 'error', message: 'runLocal not found' });
    await expect(promise).rejects.toThrow(/runLocal not found/);
  });

  it('rejects when the host disconnects before ready', async () => {
    const platform = createFakePlatform();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080 });
    platform._nativePorts[0].fireDisconnect({ message: 'host crashed' });
    await expect(promise).rejects.toThrow(/host crashed/);
  });

  it('ignores events after settling (ready wins over a late error)', async () => {
    const platform = createFakePlatform();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080 });
    const port = platform._nativePorts[0];
    port.emit({ type: 'ready', port: 8080, baseUrl: 'http://localhost:8080' });
    port.emit({ type: 'error', message: 'too late' });
    await expect(promise).resolves.toMatchObject({ port: 8080 });
  });

  it('stop() posts shutdown and disconnects the port', async () => {
    const platform = createFakePlatform();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080 });
    const port = platform._nativePorts[0];
    port.emit({ type: 'ready', port: 8080, baseUrl: 'http://localhost:8080' });
    const handle = await promise;
    handle.stop();
    expect(port.posted.some((m) => (m as { type: string }).type === 'shutdown')).toBe(true);
    expect(port.disconnected).toBe(true);
  });

  it('pingHost resolves ok on pong', async () => {
    const platform = createFakePlatform();
    const promise = pingHost(platform.native);
    const port = platform._nativePorts[0];
    expect(port.posted[0]).toMatchObject({ type: 'ping' });
    port.emit({ type: 'pong' });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('pingHost reports not-ok when the host disconnects', async () => {
    const platform = createFakePlatform();
    const promise = pingHost(platform.native);
    platform._nativePorts[0].fireDisconnect({ message: 'Native host has exited.' });
    await expect(promise).resolves.toMatchObject({ ok: false, message: 'Native host has exited.' });
  });

  it('pingHost reports not-ok when native messaging is unavailable', async () => {
    const platform = createFakePlatform();
    platform._nativeAvailable = false;
    await expect(pingHost(platform.native)).resolves.toMatchObject({ ok: false });
  });

  it('pingHost times out when the host is silent', async () => {
    vi.useFakeTimers();
    const platform = createFakePlatform();
    const promise = pingHost(platform.native, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(promise).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/timed out/i) });
  });

  it('runRepoTests posts runTests and resolves passed=true on exit 0', async () => {
    const platform = createFakePlatform();
    const promise = runRepoTests(platform.native, { repoPath: '/repo', testCmd: 'pytest -q', port: 8000 });
    const port = platform._nativePorts[0];
    expect(port.posted[0]).toMatchObject({ type: 'runTests', repoPath: '/repo', testCmd: 'pytest -q', port: 8000 });
    port.emit({ type: 'testsComplete', exitCode: 0, command: 'pytest -q', durationMs: 1200 });
    await expect(promise).resolves.toMatchObject({ exitCode: 0, passed: true, command: 'pytest -q' });
  });

  it('runRepoTests resolves passed=false on a non-zero exit', async () => {
    const platform = createFakePlatform();
    const promise = runRepoTests(platform.native, { repoPath: '/repo' });
    platform._nativePorts[0].emit({ type: 'testsComplete', exitCode: 1 });
    await expect(promise).resolves.toMatchObject({ exitCode: 1, passed: false });
  });

  it('runRepoTests rejects on a host error', async () => {
    const platform = createFakePlatform();
    const promise = runRepoTests(platform.native, { repoPath: '/repo' });
    platform._nativePorts[0].emit({ type: 'error', message: 'Could not detect a test command' });
    await expect(promise).rejects.toThrow(/test command/);
  });

  it('times out when the service never becomes ready', async () => {
    vi.useFakeTimers();
    const platform = createFakePlatform();
    const promise = bootRepoService(platform.native, { repoPath: '/repo', port: 8080, bootTimeoutMs: 1000 });
    const expectation = expect(promise).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await expectation;
    expect(platform._nativePorts[0].disconnected).toBe(true);
  });
});
