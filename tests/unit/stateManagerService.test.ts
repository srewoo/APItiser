import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '@shared/platform/testDoubles/fakePlatform';
import { setPlatformForTesting } from '@shared/platform';
import { STORAGE_KEY } from '@shared/constants';
import { loadState, replaceActiveJob, setLocalService } from '@background/core/stateManager';
import { makeJobState } from '@shared/testing/factories';

describe('stateManager — service status survives racing job writes', () => {
  let platform: ReturnType<typeof createFakePlatform>;

  beforeEach(() => {
    platform = createFakePlatform();
    setPlatformForTesting(platform);
  });
  afterEach(() => {
    setPlatformForTesting(null);
    vi.restoreAllMocks();
  });

  it('a job write based on a snapshot from before "crashed" does not revert it to "running"', async () => {
    await setLocalService({ status: 'running', baseUrl: 'http://localhost:1', updatedAt: 1 });
    const staleState = await platform.storage.get(STORAGE_KEY); // a job write reads the state…

    await setLocalService({ status: 'error', message: 'The service stopped unexpectedly.', updatedAt: 2 }); // …the crash lands…

    const realGet = platform.storage.get.bind(platform.storage);
    vi.spyOn(platform.storage, 'get').mockImplementationOnce(async (key: string) => (key === STORAGE_KEY ? staleState : realGet(key)));
    await replaceActiveJob(makeJobState({ statusText: 'run finished' })); // …then the job write saves.

    const state = await loadState();
    expect(state.activeJob?.statusText).toBe('run finished');
    expect(state.localService).toMatchObject({ status: 'error', message: 'The service stopped unexpectedly.' });
  });
});
