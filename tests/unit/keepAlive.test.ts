import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/chromeMock';
import { registerKeepAliveListener, startKeepAlive, stopKeepAlive } from '@background/core/keepAlive';
import { HEARTBEAT_ALARM } from '@shared/constants';

describe('keepAlive', () => {
  let fake: FakeChrome;

  beforeEach(() => {
    fake = installFakeChrome();
  });

  it('startKeepAlive creates the heartbeat alarm', async () => {
    await startKeepAlive();
    expect(fake.alarms.create).toHaveBeenCalledWith(
      HEARTBEAT_ALARM,
      expect.objectContaining({ periodInMinutes: expect.any(Number) })
    );
  });

  it('stopKeepAlive clears the heartbeat alarm', async () => {
    await stopKeepAlive();
    expect(fake.alarms.clear).toHaveBeenCalledWith(HEARTBEAT_ALARM);
  });

  it('registerKeepAliveListener performs a storage read-write on heartbeat alarm', async () => {
    registerKeepAliveListener();

    // Manually trigger the alarm
    (fake.alarms as unknown as { _fire(name: string): void })._fire(HEARTBEAT_ALARM);

    // Allow the async storage ops to run
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // The heartbeat should have written _heartbeat into storage
    expect(fake._store.data['_heartbeat']).toBeDefined();
  });

  it('registerKeepAliveListener ignores unrelated alarms', async () => {
    registerKeepAliveListener();
    (fake.alarms as unknown as { _fire(name: string): void })._fire('some-other-alarm');

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // _heartbeat should NOT be written for unrelated alarms
    expect(fake._store.data['_heartbeat']).toBeUndefined();
  });
});
