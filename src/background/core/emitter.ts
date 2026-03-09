import type { AppState } from '@shared/types';

const safeSend = (message: unknown): void => {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
};

export const emitProgress = (state: AppState, contextId?: string): void =>
  safeSend({ type: 'JOB_PROGRESS', payload: state, contextId });

export const emitComplete = (state: AppState, contextId?: string): void =>
  safeSend({ type: 'JOB_COMPLETE', payload: state, contextId });

export const emitError = (state: AppState, error: string, contextId?: string): void =>
  safeSend({ type: 'JOB_ERROR', payload: state, error, contextId });

export const emitStateSnapshot = (state: AppState, contextId?: string): void =>
  safeSend({ type: 'STATE_SNAPSHOT', payload: state, contextId });
