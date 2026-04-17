import { vi } from 'vitest';

export interface FakeStorageStore {
  data: Record<string, unknown>;
}

export interface FakeChrome {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(value: Record<string, unknown>): Promise<void>;
    };
  };
  runtime: {
    sendMessage(message: unknown, callback?: () => void): void;
    getURL(path: string): string;
    lastError: { message: string } | undefined;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
    onStartup: { addListener: ReturnType<typeof vi.fn> };
  };
  alarms: {
    create(alarmName: string, alarmInfo: unknown): Promise<void>;
    clear(alarmName: string): Promise<boolean>;
    onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
      removeListener(callback: (alarm: { name: string }) => void): void;
    };
    _fire(name: string): void;
  };
  notifications: {
    create(
      options: Record<string, unknown>,
      callback?: () => void
    ): void;
  };
  action: {
    setBadgeText(details: { text: string; tabId?: number }): void;
    setBadgeBackgroundColor(details: { color: string }): void;
    onClicked: { addListener: ReturnType<typeof vi.fn> };
  };
  downloads: {
    download: ReturnType<typeof vi.fn>;
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    onActivated: { addListener: ReturnType<typeof vi.fn> };
    onUpdated: { addListener: ReturnType<typeof vi.fn> };
  };
  sidePanel: {
    setOptions: ReturnType<typeof vi.fn>;
    setPanelBehavior: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  };
  // Test-internal accessors
  _store: FakeStorageStore;
  _sentMessages: unknown[];
  _notificationCalls: Array<{ title: string; message: string }>;
  _badgeCalls: Array<{ text: string; color?: string }>;
}

export const createFakeChrome = (): FakeChrome => {
  const store: FakeStorageStore = { data: {} };
  const sentMessages: unknown[] = [];
  const notificationCalls: Array<{ title: string; message: string }> = [];
  const badgeCalls: Array<{ text: string; color?: string }> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];

  return {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.data[key] }),
        set: async (value: Record<string, unknown>) => {
          Object.assign(store.data, value);
        }
      }
    },
    runtime: {
      sendMessage: (message: unknown, _callback?: () => void) => {
        sentMessages.push(message);
      },
      getURL: (path: string) => `chrome-extension://fake-id/${path}`,
      lastError: undefined,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() }
    },
    alarms: {
      create: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(true),
      onAlarm: {
        addListener: (callback: (alarm: { name: string }) => void) => {
          alarmListeners.push(callback);
        },
        removeListener: (callback: (alarm: { name: string }) => void) => {
          const idx = alarmListeners.indexOf(callback);
          if (idx > -1) alarmListeners.splice(idx, 1);
        }
      },
      _fire: (name: string) => {
        for (const listener of alarmListeners) listener({ name });
      }
    },
    notifications: {
      create: (
        options: Record<string, unknown>,
        callback?: () => void
      ) => {
        notificationCalls.push({
          title: String(options.title ?? ''),
          message: String(options.message ?? '')
        });
        callback?.();
      }
    },
    action: {
      onClicked: { addListener: vi.fn() },
      setBadgeText: ({ text, tabId }: { text: string; tabId?: number }) => {
        const last = badgeCalls[badgeCalls.length - 1];
        if (last && last.text === undefined) {
          last.text = text;
        } else {
          badgeCalls.push({ text, ...(tabId !== undefined ? {} : {}) });
        }
      },
      setBadgeBackgroundColor: ({ color }: { color: string }) => {
        const last = badgeCalls[badgeCalls.length - 1];
        if (last) {
          last.color = color;
        }
      }
    },
    downloads: {
      download: vi.fn().mockResolvedValue(undefined)
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() }
    },
    sidePanel: {
      setOptions: vi.fn().mockResolvedValue(undefined),
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined)
    },
    _store: store,
    _sentMessages: sentMessages,
    _notificationCalls: notificationCalls,
    _badgeCalls: badgeCalls
  };
};

export const installFakeChrome = (): FakeChrome => {
  const fake = createFakeChrome();
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
};
