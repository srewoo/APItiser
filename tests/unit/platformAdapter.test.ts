import { beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform, type FakePlatform } from '@shared/platform/testDoubles/fakePlatform';
import { installFakeChrome, type FakeChrome } from '../helpers/chromeMock';
import { createChromePlatform } from '@shared/platform/chromePlatform';

// ---------------------------------------------------------------------------
// Fake platform behaves as expected
// ---------------------------------------------------------------------------

describe('createFakePlatform — contract', () => {
  let platform: FakePlatform;

  beforeEach(() => {
    platform = createFakePlatform();
  });

  it('storage round-trips values', async () => {
    await platform.storage.set('foo', { x: 1 });
    expect(await platform.storage.get('foo')).toEqual({ x: 1 });
    expect(platform._store.foo).toEqual({ x: 1 });
  });

  it('storage.getAll returns everything; remove deletes a key', async () => {
    await platform.storage.set('a', 1);
    await platform.storage.set('b', 2);
    expect(await platform.storage.getAll()).toEqual({ a: 1, b: 2 });
    await platform.storage.remove('a');
    expect(await platform.storage.get('a')).toBeUndefined();
  });

  it('runtime.addMessageListener + send routes through the listener', async () => {
    platform.runtime.addMessageListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type === 'PING') {
        sendResponse({ type: 'PONG' });
      }
      return true;
    });
    const response = await platform.runtime.send<{ type: string }, { type: string }>({ type: 'PING' });
    expect(response).toEqual({ type: 'PONG' });
    expect(platform._sentMessages).toHaveLength(1);
  });

  it('downloads.download records calls for assertion', async () => {
    await platform.downloads.download({ filename: 'a.zip', url: 'data:application/zip;base64,aa', saveAs: true });
    expect(platform._downloads).toHaveLength(1);
    expect(platform._downloads[0].filename).toBe('a.zip');
  });

  it('notifications.notify records calls', () => {
    platform.notifications.notify({ title: 'APItiser', message: 'ready' });
    expect(platform._notifications[0]).toEqual({ title: 'APItiser', message: 'ready' });
  });

  it('alarms.create stores config and clear removes it', async () => {
    await platform.alarms.create('heartbeat', { periodInMinutes: 1 });
    expect(platform._alarms.get('heartbeat')).toEqual({ periodInMinutes: 1 });
    expect(await platform.alarms.clear('heartbeat')).toBe(true);
    expect(platform._alarms.has('heartbeat')).toBe(false);
  });

  it('alarms.onAlarm fires when _fireAlarm is invoked', () => {
    let fired: string | null = null;
    platform.alarms.onAlarm((alarm) => { fired = alarm.name; });
    platform._fireAlarm('heartbeat');
    expect(fired).toBe('heartbeat');
  });

  it('action badge text/color is captured', () => {
    platform.action.setBadgeText({ text: 'GEN' });
    platform.action.setBadgeBackgroundColor({ color: '#00ff00' });
    expect(platform._badge[0]).toEqual({ text: 'GEN', color: '#00ff00' });
  });

  it('tabs.query returns configured tabs', async () => {
    platform._setTabs([{ id: 1, url: 'https://github.com/acme/api' }]);
    const result = await platform.tabs.query({ active: true });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://github.com/acme/api');
  });

  it('lifecycle fires registered handlers', async () => {
    let installed = 0;
    platform.lifecycle.onInstalled(() => { installed += 1; });
    await platform._fireInstalled();
    expect(installed).toBe(1);
  });

  it('sidePanel is always available and methods are no-ops', async () => {
    expect(platform.sidePanel.isAvailable()).toBe(true);
    await expect(platform.sidePanel.setOptions({ path: 'x', enabled: true })).resolves.toBeUndefined();
    await expect(platform.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })).resolves.toBeUndefined();
    await expect(platform.sidePanel.open({ tabId: 1 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chrome-backed adapter wires to chrome.* (proved via fake chrome)
// ---------------------------------------------------------------------------

describe('createChromePlatform — chrome.* wiring', () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('storage reads/writes go through chrome.storage.local', async () => {
    const platform = createChromePlatform();
    await platform.storage.set('k', 'v');
    expect(fake._store.data.k).toBe('v');
    expect(await platform.storage.get('k')).toBe('v');
  });

  it('runtime.addMessageListener delegates to chrome.runtime.onMessage', () => {
    const platform = createChromePlatform();
    const listener = () => undefined;
    platform.runtime.addMessageListener(listener);
    expect(fake.runtime.onMessage.addListener).toHaveBeenCalledWith(listener);
  });

  it('downloads.download forwards to chrome.downloads.download', async () => {
    const platform = createChromePlatform();
    await platform.downloads.download({ filename: 'x.zip', url: 'data:application/zip;base64,aa' });
    expect(fake.downloads.download).toHaveBeenCalledWith({
      filename: 'x.zip',
      url: 'data:application/zip;base64,aa',
      saveAs: undefined
    });
  });

  it('action.setBadgeText forwards to chrome.action.setBadgeText', () => {
    const platform = createChromePlatform();
    platform.action.setBadgeText({ text: 'SCN' });
    expect(fake._badgeCalls[fake._badgeCalls.length - 1].text).toBe('SCN');
  });

  it('sidePanel.isAvailable reflects chrome.sidePanel presence', () => {
    const platform = createChromePlatform();
    expect(platform.sidePanel.isAvailable()).toBe(true);
  });
});
