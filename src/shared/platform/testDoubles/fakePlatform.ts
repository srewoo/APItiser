import type {
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
} from '../types';

/**
 * In-memory platform for tests. Exposes `_spy` helpers to assert on calls
 * without mocking the `chrome` global.
 */
export interface FakePlatform extends Platform {
  _store: Record<string, unknown>;
  _downloads: Array<{ filename: string; url: string; saveAs?: boolean }>;
  _notifications: Array<{ title: string; message: string }>;
  _badge: Array<{ text: string; color?: string }>;
  _sentMessages: unknown[];
  _messageListeners: MessageListener[];
  _alarms: Map<string, { periodInMinutes?: number; delayInMinutes?: number; when?: number }>;
  _fireAlarm(name: string): void;
  _fireActionClicked(tab: { id?: number }): void;
  _fireTabActivated(info: { tabId: number }): void;
  _fireTabUpdated(tabId: number, changeInfo: { status?: string }): void;
  _fireInstalled(): void;
  _fireStartup(): void;
  _setTabs(tabs: TabInfo[]): void;
}

export const createFakePlatform = (): FakePlatform => {
  const store: Record<string, unknown> = {};
  const downloadCalls: FakePlatform['_downloads'] = [];
  const notificationCalls: FakePlatform['_notifications'] = [];
  const badgeCalls: FakePlatform['_badge'] = [];
  const sentMessages: unknown[] = [];
  const messageListeners: MessageListener[] = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const alarmStore = new Map<string, { periodInMinutes?: number; delayInMinutes?: number; when?: number }>();
  const actionClickListeners: Array<(tab: { id?: number }) => void> = [];
  const tabActivatedListeners: Array<(info: { tabId: number }) => void> = [];
  const tabUpdatedListeners: Array<(tabId: number, changeInfo: { status?: string }) => void> = [];
  const installedListeners: Array<() => void | Promise<void>> = [];
  const startupListeners: Array<() => void | Promise<void>> = [];
  let availableTabs: TabInfo[] = [];

  const storage: StorageAdapter = {
    async get<T>(key: string): Promise<T | undefined> {
      return store[key] as T | undefined;
    },
    async set(key, value): Promise<void> {
      store[key] = value;
    },
    async getAll(): Promise<Record<string, unknown>> {
      return { ...store };
    },
    async remove(key): Promise<void> {
      delete store[key];
    }
  };

  const runtime: RuntimeMessagingAdapter = {
    async send<TMessage, TResponse>(message: TMessage): Promise<TResponse> {
      sentMessages.push(message);
      // Route through any registered listener synchronously.
      for (const listener of messageListeners) {
        const response: TResponse | undefined = await new Promise<TResponse | undefined>((resolve) => {
          const keepAlive = listener(message, {}, (value) => resolve(value as TResponse));
          if (keepAlive !== true) {
            resolve(undefined);
          }
        });
        if (response !== undefined) {
          return response;
        }
      }
      return undefined as unknown as TResponse;
    },
    addMessageListener<TMessage, TResponse>(listener: MessageListener<TMessage, TResponse>): void {
      messageListeners.push(listener as MessageListener);
    },
    removeMessageListener<TMessage, TResponse>(listener: MessageListener<TMessage, TResponse>): void {
      const idx = messageListeners.indexOf(listener as MessageListener);
      if (idx >= 0) messageListeners.splice(idx, 1);
    },
    getURL(path): string {
      return `chrome-extension://fake-id/${path}`;
    },
    lastError: undefined
  };

  const lifecycle: LifecycleAdapter = {
    onInstalled(handler): void {
      installedListeners.push(handler);
    },
    onStartup(handler): void {
      startupListeners.push(handler);
    }
  };

  const downloads: DownloadsAdapter = {
    async download(options): Promise<void> {
      downloadCalls.push(options);
    }
  };

  const notifications: NotificationsAdapter = {
    notify({ title, message }): void {
      notificationCalls.push({ title, message });
    }
  };

  const alarms: AlarmsAdapter = {
    async create(name, options): Promise<void> {
      alarmStore.set(name, options);
    },
    async clear(name): Promise<boolean> {
      return alarmStore.delete(name);
    },
    onAlarm(listener): void {
      alarmListeners.push(listener);
    }
  };

  const tabsAdapter: TabsAdapter = {
    async query(): Promise<TabInfo[]> {
      return availableTabs.slice();
    },
    onActivated(handler): void {
      tabActivatedListeners.push(handler);
    },
    onUpdated(handler): void {
      tabUpdatedListeners.push(handler);
    }
  };

  const action: ActionAdapter = {
    setBadgeText(details): void {
      const last = badgeCalls[badgeCalls.length - 1];
      if (last && last.text === '' && details.text === '') return;
      badgeCalls.push({ text: details.text });
    },
    setBadgeBackgroundColor({ color }): void {
      const last = badgeCalls[badgeCalls.length - 1];
      if (last) last.color = color;
    },
    onClicked(handler): void {
      actionClickListeners.push(handler);
    }
  };

  const sidePanel: SidePanelAdapter = {
    isAvailable(): boolean {
      return true;
    },
    async setOptions(): Promise<void> { /* no-op */ },
    async setPanelBehavior(): Promise<void> { /* no-op */ },
    async open(): Promise<void> { /* no-op */ }
  };

  return {
    storage,
    runtime,
    lifecycle,
    downloads,
    notifications,
    alarms,
    tabs: tabsAdapter,
    action,
    sidePanel,
    _store: store,
    _downloads: downloadCalls,
    _notifications: notificationCalls,
    _badge: badgeCalls,
    _sentMessages: sentMessages,
    _messageListeners: messageListeners,
    _alarms: alarmStore,
    _fireAlarm(name): void {
      for (const listener of alarmListeners) listener({ name });
    },
    _fireActionClicked(tab): void {
      for (const listener of actionClickListeners) listener(tab);
    },
    _fireTabActivated(info): void {
      for (const listener of tabActivatedListeners) listener(info);
    },
    _fireTabUpdated(tabId, changeInfo): void {
      for (const listener of tabUpdatedListeners) listener(tabId, changeInfo);
    },
    async _fireInstalled(): Promise<void> {
      for (const listener of installedListeners) await listener();
    },
    async _fireStartup(): Promise<void> {
      for (const listener of startupListeners) await listener();
    },
    _setTabs(tabs): void {
      availableTabs = tabs.slice();
    }
  };
};
