import { HEARTBEAT_ALARM } from '@shared/constants';
import { getPlatform } from '@shared/platform';

const PERIOD_MINUTES = 0.4; // 24s

export async function startKeepAlive(): Promise<void> {
  await getPlatform().alarms.create(HEARTBEAT_ALARM, { periodInMinutes: PERIOD_MINUTES });
}

export async function stopKeepAlive(): Promise<void> {
  await getPlatform().alarms.clear(HEARTBEAT_ALARM);
}

export const registerKeepAliveListener = (): void => {
  const platform = getPlatform();
  platform.alarms.onAlarm((alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) {
      return;
    }
    // Minimal storage read/write keeps the service worker alive during long LLM calls.
    void platform.storage.get('_heartbeat').then(() => {
      void platform.storage.set('_heartbeat', Date.now());
    });
  });
};
