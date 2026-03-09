import { beforeEach, describe, expect, it } from 'vitest';
import { clearContext, completeJob, loadState, replaceActiveJob, updateSettings } from '@background/core/stateManager';
import type { JobState } from '@shared/types';

const createChromeMock = () => {
  const store: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (value: Record<string, unknown>) => {
          Object.assign(store, value);
        }
      }
    }
  };
};

describe('stateManager integration', () => {
  beforeEach(() => {
    (globalThis as unknown as { chrome: unknown }).chrome = createChromeMock();
  });

  it('persists settings and active job across reads', async () => {
    await updateSettings({ framework: 'pytest', batchSize: 4 });

    const job: JobState = {
      jobId: 'job1',
      stage: 'scanning',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 40,
      statusText: 'Scanning',
      totalEndpoints: 0,
      completedBatches: 0,
      totalBatches: 0,
      endpoints: [],
      generatedTests: []
    };

    await replaceActiveJob(job);

    const next = await loadState();
    expect(next.settings.framework).toBe('pytest');
    expect(next.settings.batchSize).toBe(4);
    expect(next.activeJob?.jobId).toBe('job1');
  });

  it('moves completed jobs to history', async () => {
    const completed: JobState = {
      jobId: 'job2',
      stage: 'complete',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 100,
      statusText: 'Done',
      totalEndpoints: 1,
      completedBatches: 1,
      totalBatches: 1,
      endpoints: [],
      generatedTests: []
    };

    const state = await completeJob(completed);
    expect(state.activeJob).toBeNull();
    expect(state.jobHistory[0].jobId).toBe('job2');
  });

  it('keeps state isolated per context and supports clear', async () => {
    const alphaJob: JobState = {
      jobId: 'alpha',
      stage: 'idle',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 100,
      statusText: 'Alpha context',
      totalEndpoints: 0,
      completedBatches: 0,
      totalBatches: 0,
      endpoints: [],
      generatedTests: []
    };

    const betaJob: JobState = {
      jobId: 'beta',
      stage: 'idle',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 100,
      statusText: 'Beta context',
      totalEndpoints: 0,
      completedBatches: 0,
      totalBatches: 0,
      endpoints: [],
      generatedTests: []
    };

    await replaceActiveJob(alphaJob, 'tab:1|page:https://github.com/a/repo');
    await replaceActiveJob(betaJob, 'tab:2|page:https://github.com/b/repo');

    const alphaState = await loadState('tab:1|page:https://github.com/a/repo');
    const betaState = await loadState('tab:2|page:https://github.com/b/repo');

    expect(alphaState.activeJob?.jobId).toBe('alpha');
    expect(betaState.activeJob?.jobId).toBe('beta');

    await clearContext('tab:1|page:https://github.com/a/repo');
    const clearedAlpha = await loadState('tab:1|page:https://github.com/a/repo');
    const unchangedBeta = await loadState('tab:2|page:https://github.com/b/repo');

    expect(clearedAlpha.activeJob).toBeNull();
    expect(clearedAlpha.artifacts).toHaveLength(0);
    expect(clearedAlpha.jobHistory).toHaveLength(0);
    expect(unchangedBeta.activeJob?.jobId).toBe('beta');
  });
});
