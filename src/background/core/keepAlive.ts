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
  });
};
