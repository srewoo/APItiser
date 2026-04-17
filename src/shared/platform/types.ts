/**
 * Platform adapter interfaces. These wrap the Chrome extension APIs so that
 * business logic can be tested without mocking the `chrome` global directly.
 *
 * In production: `createChromePlatform()` returns adapters backed by chrome.*.
 * In tests:      `createFakePlatform()` returns in-memory doubles.
 */

export interface StorageAdapter {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  getAll(): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
}

export type MessageListener<TMessage = unknown, TResponse = unknown> = (
  message: TMessage,
  sender: unknown,
  sendResponse: (response: TResponse) => void
) => boolean | void;

export interface RuntimeMessagingAdapter {
  send<TMessage, TResponse>(message: TMessage): Promise<TResponse>;
  addMessageListener<TMessage, TResponse>(listener: MessageListener<TMessage, TResponse>): void;
  removeMessageListener<TMessage, TResponse>(listener: MessageListener<TMessage, TResponse>): void;
  getURL(path: string): string;
  readonly lastError?: { message: string } | undefined;
}

export interface LifecycleAdapter {
  onInstalled(handler: () => void | Promise<void>): void;
  onStartup(handler: () => void | Promise<void>): void;
}

export interface DownloadsAdapter {
  download(options: { filename: string; url: string; saveAs?: boolean }): Promise<void>;
}

export interface NotificationsAdapter {
  notify(options: { title: string; message: string; iconUrl?: string }): void;
}

export interface AlarmsAdapter {
  create(name: string, options: { periodInMinutes?: number; delayInMinutes?: number; when?: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
  onAlarm(listener: (alarm: { name: string }) => void): void;
}

export interface TabInfo {
  id?: number;
  url?: string;
  status?: string;
}

export interface TabsAdapter {
  query(query: { active?: boolean; currentWindow?: boolean }): Promise<TabInfo[]>;
  onActivated(handler: (info: { tabId: number }) => void): void;
  onUpdated(handler: (tabId: number, changeInfo: { status?: string }) => void): void;
}

export interface ActionAdapter {
  setBadgeText(details: { text: string; tabId?: number }): void;
  setBadgeBackgroundColor(details: { color: string }): void;
  onClicked(handler: (tab: { id?: number }) => void): void;
}

export interface SidePanelAdapter {
  isAvailable(): boolean;
  setOptions(options: { tabId?: number; path: string; enabled: boolean }): Promise<void>;
  setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  open(options: { tabId: number }): Promise<void>;
}

export interface Platform {
  storage: StorageAdapter;
  runtime: RuntimeMessagingAdapter;
  lifecycle: LifecycleAdapter;
  downloads: DownloadsAdapter;
  notifications: NotificationsAdapter;
  alarms: AlarmsAdapter;
  tabs: TabsAdapter;
  action: ActionAdapter;
  sidePanel: SidePanelAdapter;
}
