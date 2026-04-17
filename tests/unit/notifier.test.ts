import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome } from '../helpers/chromeMock';
import { notify } from '@background/core/notifier';

describe('notifier', () => {
  let notificationCalls: Array<{ title: string; message: string }>;

  beforeEach(() => {
    const fake = installFakeChrome();
    notificationCalls = fake._notificationCalls;
  });

  it('creates a notification with correct title and message', () => {
    notify('APItiser ready', 'Tests generated successfully');
    expect(notificationCalls).toHaveLength(1);
    expect(notificationCalls[0]?.title).toBe('APItiser ready');
    expect(notificationCalls[0]?.message).toBe('Tests generated successfully');
  });

  it('creates separate notifications for multiple calls', () => {
    notify('Scan complete', 'Found 5 endpoints');
    notify('Generation failed', 'LLM quota exceeded');
    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[0]?.title).toBe('Scan complete');
    expect(notificationCalls[1]?.title).toBe('Generation failed');
  });

  it('handles empty strings gracefully', () => {
    notify('', '');
    expect(notificationCalls[0]?.title).toBe('');
    expect(notificationCalls[0]?.message).toBe('');
  });
});
