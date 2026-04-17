import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome } from '../helpers/chromeMock';
import { emitComplete, emitError, emitProgress, emitStateSnapshot } from '@background/core/emitter';
import { makeAppState } from '@shared/testing/factories';

describe('emitter', () => {
  let sentMessages: unknown[];

  beforeEach(() => {
    const fake = installFakeChrome();
    sentMessages = fake._sentMessages;
  });

  it('emitProgress sends JOB_PROGRESS with state and contextId', () => {
    const state = makeAppState({ contextId: 'tab:1|page:https://github.com/a/b' });
    emitProgress(state, 'tab:1|page:https://github.com/a/b');
    expect(sentMessages[0]).toMatchObject({
      type: 'JOB_PROGRESS',
      payload: state,
      contextId: 'tab:1|page:https://github.com/a/b'
    });
  });

  it('emitComplete sends JOB_COMPLETE', () => {
    const state = makeAppState();
    emitComplete(state, 'global');
    expect(sentMessages[0]).toMatchObject({ type: 'JOB_COMPLETE', payload: state });
  });

  it('emitError sends JOB_ERROR with error string', () => {
    const state = makeAppState();
    emitError(state, 'LLM quota exceeded', 'global');
    expect(sentMessages[0]).toMatchObject({
      type: 'JOB_ERROR',
      payload: state,
      error: 'LLM quota exceeded'
    });
  });

  it('emitStateSnapshot sends STATE_SNAPSHOT', () => {
    const state = makeAppState();
    emitStateSnapshot(state, 'global');
    expect(sentMessages[0]).toMatchObject({ type: 'STATE_SNAPSHOT', payload: state });
  });

  it('contextId is omitted when not provided', () => {
    const state = makeAppState();
    emitProgress(state);
    const msg = sentMessages[0] as { contextId?: string };
    expect(msg.contextId).toBeUndefined();
  });
});
