import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '@shared/platform/testDoubles/fakePlatform';
import { setPlatformForTesting } from '@shared/platform';
import type { StorageAdapter } from '@shared/platform';
import { STORAGE_KEY } from '@shared/constants';
import { updateSettings, loadState } from '@background/core/stateManager';

const SECRETS_KEY = 'apitiser.secrets.v1';

const makeMemoryStorage = (): StorageAdapter => {
  const data: Record<string, unknown> = {};
  return {
    async get<T = unknown>(key: string) {
      return data[key] as T | undefined;
    },
    async set(key, value) {
      data[key] = value;
    },
    async getAll() {
      return { ...data };
    },
    async remove(key) {
      delete data[key];
    }
  };
};

describe('stateManager — ephemeral secret separation', () => {
  let session: StorageAdapter;
  let local: StorageAdapter;

  beforeEach(() => {
    const platform = createFakePlatform();
    local = platform.storage;
    session = makeMemoryStorage();
    platform.session = session;
    setPlatformForTesting(platform);
  });

  afterEach(() => {
    setPlatformForTesting(null);
  });

  it('keeps runtime validation secrets out of the on-disk blob and in session storage', async () => {
    await updateSettings({
      openAiKey: 'sk-persist-me',
      runtimeApiToken: 'super-secret-token',
      runtimeValues: { USER_ID: '42' }
    });

    const persisted = (await local.get(STORAGE_KEY)) as { settings: Record<string, unknown> };
    // Provider key persists to disk (must survive a restart)...
    expect(persisted.settings.openAiKey).toBe('sk-persist-me');
    // ...but the ephemeral runtime secrets do NOT.
    expect(persisted.settings.runtimeApiToken).toBeUndefined();
    expect(persisted.settings.runtimeValues).toBeUndefined();

    const secrets = (await session.get(SECRETS_KEY)) as Record<string, unknown>;
    expect(secrets.runtimeApiToken).toBe('super-secret-token');
    expect(secrets.runtimeValues).toEqual({ USER_ID: '42' });
  });

  it('merges session secrets back into settings on load', async () => {
    await updateSettings({ runtimeApiToken: 'tok', openAiKey: 'sk-x' });
    const state = await loadState();
    expect(state.settings.runtimeApiToken).toBe('tok');
    expect(state.settings.openAiKey).toBe('sk-x');
  });
});
