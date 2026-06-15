import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsModal } from '@popup/components/SettingsModal';
import { makeAppState, makeSettings } from '@shared/testing/factories';

afterEach(cleanup);

const renderModal = (overrides?: Partial<Parameters<typeof SettingsModal>[0]>) => {
  const handlers = {
    onClose: vi.fn(),
    onPatchSettings: vi.fn(),
    onTestDirsChange: vi.fn(),
    onOpenApiFallbackChange: vi.fn(),
    onCategoryToggle: vi.fn(),
    onValidateAccess: vi.fn(),
    onPersistTestFolders: vi.fn(),
    onPersistOpenApiFallback: vi.fn(),
    onImportOpenApiFile: vi.fn(),
    onOpenDoc: vi.fn(),
    onExportSettings: vi.fn(),
    onImportSettings: vi.fn()
  };
  render(
    <SettingsModal
      appState={makeAppState({ settings: makeSettings() })}
      testDirsInput="tests, __tests__"
      openApiFallbackInput=""
      busy={false}
      hasRepo
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
};

describe('SettingsModal', () => {
  it('renders the major configuration sections', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('Provider & Model')).toBeTruthy();
    expect(screen.getByText('Repo Access')).toBeTruthy();
    expect(screen.getByText('Test Configuration')).toBeTruthy();
    expect(screen.getByText(/OpenAPI Fallback/)).toBeTruthy();
    expect(screen.getByText('Settings Backup')).toBeTruthy();
  });

  it('closes via the close button', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('patches settings when the provider is changed', () => {
    const { onPatchSettings } = renderModal();
    const select = screen.getByDisplayValue('OpenAI');
    fireEvent.change(select, { target: { value: 'claude' } });
    expect(onPatchSettings).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' }));
  });

  it('warns on blur when an API key does not match the provider prefix', () => {
    const { onPatchSettings } = renderModal();
    const keyInput = screen.getByPlaceholderText('Paste provider API key');
    fireEvent.change(keyInput, { target: { value: 'totally-wrong-key' } });
    fireEvent.blur(keyInput, { target: { value: 'totally-wrong-key' } });
    expect(screen.getByText(/keys usually start with/)).toBeTruthy();
    expect(onPatchSettings).toHaveBeenCalledWith(expect.objectContaining({ openAiKey: 'totally-wrong-key' }));
  });

  it('triggers repo access validation', () => {
    const { onValidateAccess } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Validate Access/i }));
    expect(onValidateAccess).toHaveBeenCalled();
  });

  it('disables Validate Access when there is no repo', () => {
    renderModal({ hasRepo: false });
    expect((screen.getByRole('button', { name: /Validate Access/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggles a test category', () => {
    const { onCategoryToggle } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /security/i }));
    expect(onCategoryToggle).toHaveBeenCalledWith('security');
  });

  it('exports settings and opens help / privacy docs', () => {
    const { onExportSettings, onOpenDoc } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Export Settings/i }));
    expect(onExportSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Help/i }));
    expect(onOpenDoc).toHaveBeenCalledWith('help.html');
  });

  it('changes the test framework selection', () => {
    const { onPatchSettings } = renderModal();
    const frameworkSelect = screen.getByDisplayValue('Jest');
    fireEvent.change(frameworkSelect, { target: { value: 'pytest' } });
    expect(onPatchSettings).toHaveBeenCalledWith(expect.objectContaining({ framework: 'pytest' }));
  });
});
