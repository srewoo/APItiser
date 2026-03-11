import { useState } from 'react';
import { PROVIDER_MODELS } from '@shared/constants';
import type { AppState, TestCategory } from '@shared/types';

type KeyProvider = 'openai' | 'claude' | 'gemini';

const API_KEY_PATTERNS: Record<KeyProvider, { prefix: string; minLength: number }> = {
  openai: { prefix: 'sk-', minLength: 40 },
  claude: { prefix: 'sk-ant-', minLength: 50 },
  gemini: { prefix: 'AIza', minLength: 36 }
};

const validateApiKey = (value: string, provider: KeyProvider): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const pattern = API_KEY_PATTERNS[provider];
  if (!trimmed.startsWith(pattern.prefix)) {
    return `${provider} keys usually start with "${pattern.prefix}"`;
  }
  if (trimmed.length < pattern.minLength) {
    return `Key looks too short (expected ≥${pattern.minLength} chars)`;
  }
  return null;
};

interface SettingsModalProps {
  appState: AppState | null;
  testDirsInput: string;
  openApiFallbackInput: string;
  busy: boolean;
  hasRepo: boolean;
  onClose: () => void;
  onPatchSettings: (patch: Partial<AppState['settings']>) => void;
  onTestDirsChange: (value: string) => void;
  onOpenApiFallbackChange: (value: string) => void;
  onCategoryToggle: (category: TestCategory) => void;
  onValidateAccess: () => void;
  onPersistTestFolders: () => void;
  onPersistOpenApiFallback: () => void;
  onImportOpenApiFile: (file: File | null | undefined) => void;
  onOpenDoc: (path: 'help.html' | 'policypolicy.html') => void;
  onExportSettings: () => void;
  onImportSettings: (file: File | null | undefined) => void;
}

export function SettingsModal({
  appState,
  testDirsInput,
  openApiFallbackInput,
  busy,
  hasRepo,
  onClose,
  onPatchSettings,
  onTestDirsChange,
  onOpenApiFallbackChange,
  onCategoryToggle,
  onValidateAccess,
  onPersistTestFolders,
  onPersistOpenApiFallback,
  onImportOpenApiFile,
  onOpenDoc,
  onExportSettings,
  onImportSettings,
}: SettingsModalProps) {
  const [keyWarning, setKeyWarning] = useState('');

  const selectedProvider = appState?.settings.provider ?? 'openai';
  const availableModels = PROVIDER_MODELS[selectedProvider];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="panel settings-panel modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="ghost modal-close" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Provider & Model */}
        <div className="settings-group">
          <h3>Provider &amp; Model</h3>
          <div className="grid two">
            <label>
              Provider
              <select
                value={appState?.settings.provider ?? 'openai'}
                onChange={(event) =>
                  onPatchSettings({
                    provider: event.target.value as AppState['settings']['provider'],
                    model: PROVIDER_MODELS[event.target.value as keyof typeof PROVIDER_MODELS][0]
                  })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
            <label>
              Model
              <select
                value={appState?.settings.model ?? availableModels[0]}
                onChange={(event) => onPatchSettings({ model: event.target.value })}
              >
                {availableModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            API Key
            <input
              type="password"
              placeholder="Paste provider API key"
              defaultValue={
                selectedProvider === 'openai'
                  ? appState?.settings.openAiKey ?? ''
                  : selectedProvider === 'claude'
                    ? appState?.settings.claudeKey ?? ''
                    : appState?.settings.geminiKey ?? ''
              }
              onBlur={(event) => {
                const trimmed = event.target.value.trim();
                const warning = validateApiKey(trimmed, selectedProvider as KeyProvider);
                setKeyWarning(warning ?? '');
                if (selectedProvider === 'openai') {
                  onPatchSettings({ openAiKey: trimmed });
                } else if (selectedProvider === 'claude') {
                  onPatchSettings({ claudeKey: trimmed });
                } else {
                  onPatchSettings({ geminiKey: trimmed });
                }
              }}
            />
            {keyWarning ? <small className="key-warning">{keyWarning}</small> : null}
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.enableProviderFallback ?? false}
              onChange={(event) => onPatchSettings({ enableProviderFallback: event.target.checked })}
            />
            Auto-fallback to next provider on failure
          </label>
        </div>

        {/* Repo Access */}
        <div className="settings-group">
          <h3>Repo Access</h3>
          <div className="grid two">
            <label>
              GitHub Token
              <input
                type="password"
                defaultValue={appState?.settings.githubToken ?? ''}
                onBlur={(event) => onPatchSettings({ githubToken: event.target.value.trim() })}
                placeholder="Optional for public repos"
              />
            </label>
            <label>
              GitLab Token
              <input
                type="password"
                defaultValue={appState?.settings.gitlabToken ?? ''}
                onBlur={(event) => onPatchSettings({ gitlabToken: event.target.value.trim() })}
                placeholder="Required for private repos"
              />
            </label>
          </div>
          <label>
            GitLab Base URL
            <input
              type="text"
              value={appState?.settings.gitlabBaseUrl ?? 'https://gitlab.com'}
              onChange={(event) => onPatchSettings({ gitlabBaseUrl: event.target.value })}
              placeholder="https://gitlab.company.com"
            />
          </label>

          <button type="button" className="ghost utility-btn" onClick={onValidateAccess} disabled={busy || !hasRepo}>
            Validate Access
          </button>

          {appState?.lastValidation ? (
            <div className={`validation-box ${appState.lastValidation.ok ? 'ok' : 'warn'}`}>
              {appState.lastValidation.checks.map((check) => (
                <p key={`${check.name}-${check.detail}`} className={`validation-item ${check.status}`}>
                  <strong>{check.name}:</strong> {check.detail}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        {/* Test Configuration */}
        <div className="settings-group">
          <h3>Test Configuration</h3>
          <div className="grid two">
            <label>
              Framework
              <select
                value={appState?.settings.framework ?? 'jest'}
                onChange={(event) => onPatchSettings({ framework: event.target.value as AppState['settings']['framework'] })}
              >
                <option value="jest">Jest</option>
                <option value="mocha">Mocha + Chai</option>
                <option value="pytest">Pytest</option>
              </select>
            </label>
            <label>
              Batch Size
              <input
                type="number"
                min={1}
                max={20}
                value={appState?.settings.batchSize ?? 6}
                onChange={(event) => onPatchSettings({ batchSize: Number(event.target.value) })}
              />
            </label>
          </div>
          <label>
            Timeout Per Batch (seconds)
            <input
              type="number"
              min={30}
              max={1200}
              value={Math.round((appState?.settings.timeoutMs ?? 300000) / 1000)}
              onChange={(event) => onPatchSettings({ timeoutMs: Number(event.target.value) * 1000 })}
            />
          </label>
          <label>
            Base URL (for generated tests)
            <input
              type="text"
              value={appState?.settings.baseUrl ?? ''}
              onChange={(event) => onPatchSettings({ baseUrl: event.target.value.trim() })}
              placeholder="http://localhost:3000"
            />
          </label>
          <label>
            Test Files Folders (comma-separated)
            <input
              type="text"
              value={testDirsInput}
              onChange={(event) => onTestDirsChange(event.target.value)}
              onBlur={onPersistTestFolders}
              placeholder="tests, __tests__, api-tests"
            />
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.skipExistingTests ?? true}
              onChange={(event) => onPatchSettings({ skipExistingTests: event.target.checked })}
            />
            Skip endpoints that already have tests
          </label>

          <div className="category-row">
            {(['positive', 'negative', 'edge', 'security'] as const).map((category) => (
              <button
                key={category}
                type="button"
                className={`chip ${appState?.settings.includeCategories.includes(category) ? 'active' : ''}`}
                onClick={() => onCategoryToggle(category)}
              >
                {category}
              </button>
            ))}
          </div>

          {/* Custom Prompt Instructions */}
          <label>
            Custom Prompt Instructions
            <textarea
              className="spec-input"
              rows={4}
              value={appState?.settings.customPromptInstructions ?? ''}
              onChange={(event) => onPatchSettings({ customPromptInstructions: event.target.value })}
              placeholder="Always test pagination with limit=0. Use project-specific auth header X-Custom-Auth."
            />
          </label>
        </div>

        {/* OpenAPI Fallback */}
        <div className="settings-group">
          <h3>OpenAPI Fallback</h3>
          <p className="subtle">
            Optional: paste or import OpenAPI spec. It will be merged into scan results as a fallback source.
          </p>
          <label>
            Import Spec File
            <input
              type="file"
              accept=".json,.yaml,.yml,application/json,text/yaml"
              onChange={(event) => onImportOpenApiFile(event.target.files?.[0])}
            />
          </label>
          <label>
            OpenAPI Spec (JSON/YAML)
            <textarea
              className="spec-input"
              rows={8}
              value={openApiFallbackInput}
              onChange={(event) => onOpenApiFallbackChange(event.target.value)}
              onBlur={onPersistOpenApiFallback}
              placeholder="openapi: 3.0.0"
            />
          </label>
          <button
            type="button"
            className="ghost utility-btn"
            onClick={() => {
              onOpenApiFallbackChange('');
              onPatchSettings({ openApiFallbackSpec: '' });
            }}
            disabled={!openApiFallbackInput.trim()}
          >
            Clear Fallback Spec
          </button>
        </div>

        {/* Settings Import/Export */}
        <div className="settings-group">
          <h3>Settings Backup</h3>
          <div className="grid two">
            <button type="button" className="ghost utility-btn" onClick={onExportSettings}>
              Export Settings
            </button>
            <label className="ghost utility-btn settings-import-label">
              Import Settings
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(event) => onImportSettings(event.target.files?.[0])}
              />
            </label>
          </div>
          <p className="subtle">API keys are excluded from export.</p>
        </div>

        {/* Help & Policy */}
        <div className="settings-group">
          <h3>Help &amp; Policy</h3>
          <div className="grid two">
            <button type="button" className="ghost utility-btn" onClick={() => onOpenDoc('help.html')}>
              Help
            </button>
            <button type="button" className="ghost utility-btn" onClick={() => onOpenDoc('policypolicy.html')}>
              Privacy Policy
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
