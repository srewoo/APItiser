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
  TabsAdapter
} from './types';

const storage = (): StorageAdapter => ({
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const result = await chrome.storage.local.get(key);
    return result?.[key] as T | undefined;
  },
  async set(key, value): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async getAll(): Promise<Record<string, unknown>> {
    return (await chrome.storage.local.get(null)) as Record<string, unknown>;
  },
  async remove(key): Promise<void> {
    await chrome.storage.local.remove(key);
  }
});

const runtime = (): RuntimeMessagingAdapter => ({
  send<TMessage, TResponse>(message: TMessage): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response: TResponse) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
  addMessageListener<TMessage, TResponse>(listener: MessageListener<TMessage, TResponse>): void {
    chrome.runtime.onMessage.addListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
  },
  removeMessageListener<TMessage, TResponse>(listener: MessageListener<TMessage, TResponse>): void {
    chrome.runtime.onMessage.removeListener(listener as Parameters<typeof chrome.runtime.onMessage.removeListener>[0]);
  },
  getURL(path: string): string {
    return chrome.runtime.getURL(path);
  },
  get lastError(): { message: string } | undefined {
    const err = chrome.runtime.lastError;
    return err ? { message: err.message ?? 'Unknown chrome.runtime error' } : undefined;
  }
});

const lifecycle = (): LifecycleAdapter => ({
  onInstalled(handler): void {
    chrome.runtime.onInstalled.addListener(() => {
      void handler();
    });
  },
  onStartup(handler): void {
    chrome.runtime.onStartup.addListener(() => {
      void handler();
    });
  }
});

const downloads = (): DownloadsAdapter => ({
  async download({ filename, url, saveAs }): Promise<void> {
    await chrome.downloads.download({ filename, url, saveAs });
  }
});

const notifications = (): NotificationsAdapter => ({
  notify({ title, message, iconUrl }): void {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: iconUrl ?? chrome.runtime.getURL('icons/icon128.png'),
      title,
      message
    });
  }
});

const alarms = (): AlarmsAdapter => ({
  async create(name, options): Promise<void> {
    await chrome.alarms.create(name, options);
  },
  async clear(name): Promise<boolean> {
    return chrome.alarms.clear(name);
  },
  onAlarm(listener): void {
    chrome.alarms.onAlarm.addListener(listener);
  }
});

const tabs = (): TabsAdapter => ({
  async query(queryInfo): Promise<Array<{ id?: number; url?: string; status?: string }>> {
    const result = await chrome.tabs.query(queryInfo);
    return result.map((tab) => ({ id: tab.id, url: tab.url, status: tab.status }));
  },
  onActivated(handler): void {
    chrome.tabs.onActivated.addListener(({ tabId }) => handler({ tabId }));
  },
  onUpdated(handler): void {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => handler(tabId, { status: changeInfo.status }));
  }
});

const action = (): ActionAdapter => ({
  setBadgeText(details): void {
    chrome.action.setBadgeText(details);
  },
  setBadgeBackgroundColor(details): void {
    chrome.action.setBadgeBackgroundColor(details);
  },
  onClicked(handler): void {
    chrome.action.onClicked.addListener((tab) => handler({ id: tab.id }));
  }
});

const sidePanel = (): SidePanelAdapter => ({
  isAvailable(): boolean {
    return typeof chrome.sidePanel !== 'undefined';
  },
  async setOptions(options): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await chrome.sidePanel.setOptions(options);
  },
  async setPanelBehavior(behavior): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await chrome.sidePanel.setPanelBehavior(behavior);
  },
  async open(options): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await chrome.sidePanel.open(options);
  }
});

export const createChromePlatform = (): Platform => ({
  storage: storage(),
  runtime: runtime(),
  lifecycle: lifecycle(),
  downloads: downloads(),
  notifications: notifications(),
  alarms: alarms(),
  tabs: tabs(),
  action: action(),
  sidePanel: sidePanel()
});
