import type { JobState } from '@shared/types';
import { getPlatform } from '@shared/platform';

const setBadge = (text: string, color: string) => {
  const { action } = getPlatform();
  action.setBadgeText({ text });
  action.setBadgeBackgroundColor({ color });
};

export const clearBadge = () => setBadge('', '#000000');

export const updateBadgeForJob = (job: JobState | null): void => {
  if (!job) {
    clearBadge();
    return;
  }

  if (job.stage === 'scanning') {
    setBadge('SCN', '#1a4f91');
    return;
  }

  if (job.stage === 'generating') {
    if (job.totalBatches > 0) {
      setBadge(`${job.completedBatches}/${job.totalBatches}`, '#8a5300');
      return;
    }
    setBadge('GEN', '#8a5300');
    return;
  }

  if (job.stage === 'packaging') {
    setBadge('ZIP', '#7b1fa2');
    return;
  }

  if (job.stage === 'complete') {
    setBadge('RDY', '#0b6b2f');
    return;
  }

  if (job.stage === 'error') {
    setBadge('Err', '#a70f24');
    return;
  }

  if (job.stage === 'cancelled') {
    setBadge('Stop', '#4f4f4f');
    return;
  }

  clearBadge();
};
