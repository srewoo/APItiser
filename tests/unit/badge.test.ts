import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome } from '../helpers/chromeMock';
import { clearBadge, updateBadgeForJob } from '@background/core/badge';
import { makeJobState } from '@shared/testing/factories';

describe('badge', () => {
  let badgeCalls: Array<{ text: string; color?: string }>;

  beforeEach(() => {
    const fake = installFakeChrome();
    badgeCalls = fake._badgeCalls;
  });

  it('clearBadge sets empty text', () => {
    clearBadge();
    expect(badgeCalls[0]?.text).toBe('');
  });

  it('null job clears badge', () => {
    updateBadgeForJob(null);
    expect(badgeCalls[0]?.text).toBe('');
  });

  it('scanning job shows SCN', () => {
    updateBadgeForJob(makeJobState({ stage: 'scanning' }));
    expect(badgeCalls[0]?.text).toBe('SCN');
  });

  it('generating job with no batches shows GEN', () => {
    updateBadgeForJob(makeJobState({ stage: 'generating', totalBatches: 0 }));
    expect(badgeCalls[0]?.text).toBe('GEN');
  });

  it('generating job with batches shows progress fraction', () => {
    updateBadgeForJob(makeJobState({ stage: 'generating', completedBatches: 2, totalBatches: 5 }));
    expect(badgeCalls[0]?.text).toBe('2/5');
  });

  it('packaging job shows ZIP', () => {
    updateBadgeForJob(makeJobState({ stage: 'packaging' }));
    expect(badgeCalls[0]?.text).toBe('ZIP');
  });

  it('complete job shows RDY', () => {
    updateBadgeForJob(makeJobState({ stage: 'complete' }));
    expect(badgeCalls[0]?.text).toBe('RDY');
  });

  it('error job shows Err', () => {
    updateBadgeForJob(makeJobState({ stage: 'error' }));
    expect(badgeCalls[0]?.text).toBe('Err');
  });

  it('cancelled job shows Stop', () => {
    updateBadgeForJob(makeJobState({ stage: 'cancelled' }));
    expect(badgeCalls[0]?.text).toBe('Stop');
  });

  it('idle job clears badge', () => {
    updateBadgeForJob(makeJobState({ stage: 'idle' }));
    expect(badgeCalls[0]?.text).toBe('');
  });
});
