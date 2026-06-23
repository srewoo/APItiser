import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '@shared/types';
import type { CommandMessage, EventMessage } from '@shared/messages';
import { sendCommand } from '../runtime';

export interface UsePopupStateResult {
  appState: AppState | null;
  setAppState: (state: AppState | null) => void;
  contextId: string;
  setContextId: (id: string) => void;
  dispatch: (command: CommandMessage) => Promise<EventMessage>;
  error: string;
  setError: (message: string) => void;
}

export const usePopupState = (): UsePopupStateResult => {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [contextId, setContextIdState] = useState<string>('global');
  const [error, setError] = useState<string>('');
  const contextRef = useRef<string>('global');

  const setContextId = useCallback((id: string) => {
    contextRef.current = id;
    setContextIdState(id);
  }, []);

  useEffect(() => {
    const listener = (message: EventMessage) => {
      if ('contextId' in message && message.contextId && message.contextId !== contextRef.current) {
        return;
      }
      if (
        message.type === 'JOB_PROGRESS' ||
        message.type === 'JOB_COMPLETE' ||
        message.type === 'STATE_SNAPSHOT' ||
        message.type === 'JOB_ERROR' ||
        message.type === 'SETTINGS_SAVED'
      ) {
        setAppState(message.payload);
      }
      if (message.type === 'JOB_ERROR') {
        setError(message.error);
      } else if (message.type === 'JOB_COMPLETE') {
        // A cleanly completed job clears any stale error banner. (Deliberately NOT on
        // JOB_PROGRESS — a late progress tick from a parallel job must not wipe a fresh error.)
        setError('');
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const dispatch = useCallback(
    async (command: CommandMessage): Promise<EventMessage> => {
      const cmdWithContext: CommandMessage = { ...command, contextId: contextRef.current };
      return sendCommand<EventMessage>(cmdWithContext);
    },
    []
  );

  return { appState, setAppState, contextId, setContextId, dispatch, error, setError };
};
