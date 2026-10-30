import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandMessage, EventMessage } from '@shared/messages';
import { makeAppState, makeSettings } from '@shared/testing/factories';

// The wizard talks to the service worker exclusively through sendCommand — mock that seam.
const sendCommand = vi.fn<(msg: CommandMessage) => Promise<EventMessage>>();
vi.mock('@popup/runtime', () => ({ sendCommand: (msg: CommandMessage) => sendCommand(msg) }));

import { Onboarding } from '../../src/onboarding/Onboarding';

const stateSnapshot = (settingsOverrides = {}): EventMessage => ({
  type: 'STATE_SNAPSHOT',
  payload: makeAppState({ settings: makeSettings(settingsOverrides) })
});

afterEach(cleanup);

beforeEach(() => {
  sendCommand.mockReset();
  // Default: fresh install, nothing configured.
  sendCommand.mockImplementation(async (message: CommandMessage) => {
    switch (message.type) {
      case 'GET_STATE':
        return stateSnapshot();
      case 'SAVE_SETTINGS':
        return { type: 'SETTINGS_SAVED', payload: makeAppState({ settings: makeSettings(message.payload) }) };
      case 'TEST_PROVIDER_KEY':
        return { type: 'PROVIDER_KEY_STATUS', payload: { ok: true, message: 'Key valid' } };
      case 'TEST_REPO_TOKEN':
        return { type: 'REPO_TOKEN_STATUS', payload: { ok: true, message: 'Token is valid.' } };
      case 'CHECK_LOCAL_RUNNER':
        return { type: 'LOCAL_RUNNER_STATUS', payload: { hostOk: true, serviceOk: false, hostMessage: 'ok' } };
      default:
        return { type: 'ACK' };
    }
  });
  Object.defineProperty(window, 'close', { value: vi.fn(), writable: true });
});

const advance = () => fireEvent.click(screen.getByRole('button', { name: /Get started|Continue/ }));

describe('Onboarding wizard', () => {
  it('loads current settings on mount and shows the welcome step', async () => {
    render(<Onboarding />);
    expect(await screen.findByRole('heading', { name: /Welcome to APItiser/ })).toBeTruthy();
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'GET_STATE' })));
  });

  it('tests and saves a provider key on the AI provider step', async () => {
    render(<Onboarding />);
    await screen.findByRole('heading', { name: /Welcome to APItiser/ });
    advance(); // -> AI provider

    const keyInput = await screen.findByPlaceholderText(/sk-/);
    fireEvent.change(keyInput, { target: { value: 'sk-test-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Test & save key/ }));

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TEST_PROVIDER_KEY', payload: expect.objectContaining({ apiKey: 'sk-test-123' }) })
      )
    );
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SAVE_SETTINGS', payload: expect.objectContaining({ openAiKey: 'sk-test-123' }) })
      )
    );
    expect(await screen.findByText(/Key valid/)).toBeTruthy();
  });

  it('surfaces a failed key test without saving it', async () => {
    sendCommand.mockImplementation(async (message: CommandMessage) => {
      if (message.type === 'GET_STATE') return stateSnapshot();
      if (message.type === 'TEST_PROVIDER_KEY') return { type: 'PROVIDER_KEY_STATUS', payload: { ok: false, message: 'Unauthorized' } };
      return { type: 'ACK' };
    });
    render(<Onboarding />);
    await screen.findByRole('heading', { name: /Welcome to APItiser/ });
    advance();
    fireEvent.change(await screen.findByPlaceholderText(/sk-/), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: /Test & save key/ }));

    expect(await screen.findByText(/Unauthorized/)).toBeTruthy();
    expect(sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'SAVE_SETTINGS' }));
  });

  it('marks onboarding complete and closes the tab on finish', async () => {
    render(<Onboarding />);
    await screen.findByRole('heading', { name: /Welcome to APItiser/ });
    advance(); // AI provider
    advance(); // Generation
    advance(); // Repository
    advance(); // Live validation
    advance(); // Local runs
    advance(); // All set
    const finish = await screen.findByRole('button', { name: /^Finish$/ });
    fireEvent.click(finish);

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SAVE_SETTINGS',
          payload: expect.objectContaining({ onboardingCompletedAt: expect.any(Number) })
        })
      )
    );
    await waitFor(() => expect(window.close).toHaveBeenCalled());
  });

  it('tests a GitHub token individually and saves it on success', async () => {
    render(<Onboarding />);
    await screen.findByRole('heading', { name: /Welcome to APItiser/ });
    advance(); // AI provider
    advance(); // Generation
    advance(); // Repository
    fireEvent.change(await screen.findByPlaceholderText(/ghp_/), { target: { value: 'ghp_valid' } });
    fireEvent.click(screen.getByRole('button', { name: /Test GitHub token/ }));

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TEST_REPO_TOKEN', payload: expect.objectContaining({ platform: 'github', token: 'ghp_valid' }) })
      )
    );
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SAVE_SETTINGS', payload: expect.objectContaining({ githubToken: 'ghp_valid' }) })
      )
    );
    expect(await screen.findByText(/Token is valid/)).toBeTruthy();
  });

  it('lets the user download, enable, and check the local runner in the Local runs step', async () => {
    render(<Onboarding />);
    await screen.findByRole('heading', { name: /Welcome to APItiser/ });
    advance(); // AI provider
    advance(); // Generation
    advance(); // Repository
    advance(); // Live validation
    advance(); // Local runs

    fireEvent.click(await screen.findByRole('button', { name: /Download runner/ }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'DOWNLOAD_RUNNER' })));

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SAVE_SETTINGS', payload: expect.objectContaining({ enableLocalRunner: true }) })
      )
    );

    fireEvent.click(screen.getByRole('button', { name: /Check installation/ }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'CHECK_LOCAL_RUNNER' })));
    expect(await screen.findByText(/Host reachable/)).toBeTruthy();
  });

  it('persists repository tokens when advancing past the repo step', async () => {
    render(<Onboarding />);
    await screen.findByRole('heading', { name: /Welcome to APItiser/ });
    advance(); // AI provider
    advance(); // Generation
    advance(); // Repository
    fireEvent.change(await screen.findByPlaceholderText(/ghp_/), { target: { value: 'ghp_secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SAVE_SETTINGS', payload: expect.objectContaining({ githubToken: 'ghp_secret' }) })
      )
    );
  });
});
