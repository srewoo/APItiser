import { HEARTBEAT_ALARM } from '@shared/constants';

const PERIOD_MINUTES = 0.4; // 24s

export async function startKeepAlive(): Promise<void> {
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: PERIOD_MINUTES });
}

export async function stopKeepAlive(): Promise<void> {
  await chrome.alarms.clear(HEARTBEAT_ALARM);
}

export const registerKeepAliveListener = (): void => {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) {
      return;
    }
    // Perform a minimal storage read to keep the service worker alive.
    // Without this, Chrome can terminate the worker during long LLM calls
    // even though an alarm is registered.
    void chrome.storage.local.get('_heartbeat').then(() => {
      void chrome.storage.local.set({ _heartbeat: Date.now() });
    });
  });
};
