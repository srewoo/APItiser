import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePopupState } from '@popup/hooks/usePopupState';
import { makeAppState } from '@shared/testing/factories';
import type { EventMessage } from '@shared/messages';

// Capture the listener the hook registers so tests can push events at it.
let registeredListener: ((message: EventMessage) => void) | null = null;
const sendMessage = vi.fn();

beforeEach(() => {
  registeredListener = null;
  sendMessage.mockReset().mockResolvedValue({ type: 'STATE_SNAPSHOT', payload: makeAppState() });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (fn: (message: EventMessage) => void) => {
          registeredListener = fn;
        },
        removeListener: vi.fn()
      }
    }
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePopupState', () => {
  it('starts with no app state and the global context', () => {
    const { result } = renderHook(() => usePopupState());
    expect(result.current.appState).toBeNull();
    expect(result.current.contextId).toBe('global');
  });

  it('updates app state from a STATE_SNAPSHOT event', () => {
    const { result } = renderHook(() => usePopupState());
    const snapshot = makeAppState({ contextId: 'global' });
    act(() => registeredListener?.({ type: 'STATE_SNAPSHOT', payload: snapshot }));
    expect(result.current.appState).toEqual(snapshot);
  });

  it('captures the error message from a JOB_ERROR event', () => {
    const { result } = renderHook(() => usePopupState());
    act(() => registeredListener?.({ type: 'JOB_ERROR', error: 'scan failed', payload: makeAppState() }));
    expect(result.current.error).toBe('scan failed');
  });

  it('ignores events addressed to a different context', () => {
    const { result } = renderHook(() => usePopupState());
    act(() => result.current.setContextId('tab-7'));
    act(() =>
      registeredListener?.({
        type: 'STATE_SNAPSHOT',
        contextId: 'some-other-context',
        payload: makeAppState({ contextId: 'some-other-context' })
      })
    );
    expect(result.current.appState).toBeNull();
  });

  it('dispatch forwards the command stamped with the active context id', async () => {
    const { result } = renderHook(() => usePopupState());
    act(() => result.current.setContextId('tab-7'));
    await act(async () => {
      await result.current.dispatch({ type: 'SCAN_REPO', payload: { repoUrl: 'https://github.com/a/b' } } as never);
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'SCAN_REPO', contextId: 'tab-7' }));
  });

  it('removes its listener on unmount', () => {
    const removeListener = vi.fn();
    (
      globalThis as unknown as { chrome: { runtime: { onMessage: { removeListener: unknown } } } }
    ).chrome.runtime.onMessage.removeListener = removeListener;
    const { unmount } = renderHook(() => usePopupState());
    unmount();
    expect(removeListener).toHaveBeenCalled();
  });
});
