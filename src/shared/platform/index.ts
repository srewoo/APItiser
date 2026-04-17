import { createChromePlatform } from './chromePlatform';
import type { Platform } from './types';

export type {
  ActionAdapter,
  AlarmsAdapter,
  DownloadsAdapter,
  LifecycleAdapter,
  MessageListener,
  NotificationsAdapter,
  Platform,
  RuntimeMessagingAdapter,
  SidePanelAdapter,
  StorageAdapter,
  TabInfo,
  TabsAdapter
} from './types';
export { createChromePlatform } from './chromePlatform';

/**
 * Module-level platform singleton. Business logic should import `getPlatform()`
 * rather than touching `chrome.*` directly.
 *
 * In tests: call `setPlatformForTesting(fake)` before exercising code paths.
 */
let activePlatform: Platform | null = null;

export const getPlatform = (): Platform => {
  if (!activePlatform) {
    activePlatform = createChromePlatform();
  }
  return activePlatform;
};

export const setPlatformForTesting = (platform: Platform | null): void => {
  activePlatform = platform;
};
