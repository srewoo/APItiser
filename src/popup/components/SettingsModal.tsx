import { useEffect, useState } from 'react';
import { PROVIDER_MODELS } from '@shared/constants';
import type { AppState, RuntimeSetupStep, TestCategory } from '@shared/types';

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

interface SetupStepDraft {
  id: string;
  name: string;
  method: string;
  path: string;
  expectedStatus: string;
  headersText: string;
  queryText: string;
  bodyText: string;
  extractJsonApiToken: string;
  extractJsonApiKey: string;
  extractJsonCsrfToken: string;
  extractJsonSessionCookie: string;
  extractHeaderApiToken: string;
  extractHeaderApiKey: string;
  extractHeaderCsrfToken: string;
  extractHeaderSessionCookie: string;
  extractCookieName: string;
}

const stringifyDraftValue = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }
  return JSON.stringify(value, null, 2);
};

const parseOptionalJson = (label: string, value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
};

const createDraftFromStep = (step?: RuntimeSetupStep): SetupStepDraft => ({
  id: step?.id ?? `step-${Date.now()}`,
  name: step?.name ?? 'Login',
  method: step?.method ?? 'POST',
  path: step?.path ?? '/auth/login',
  expectedStatus: step?.expectedStatus ? String(step.expectedStatus) : '200',
  headersText: stringifyDraftValue(step?.headers),
  queryText: stringifyDraftValue(step?.query),
  bodyText: stringifyDraftValue(step?.body),
  extractJsonApiToken: step?.extractJsonPaths?.apiToken ?? '',
  extractJsonApiKey: step?.extractJsonPaths?.apiKey ?? '',
  extractJsonCsrfToken: step?.extractJsonPaths?.csrfToken ?? '',
  extractJsonSessionCookie: step?.extractJsonPaths?.sessionCookie ?? '',
  extractHeaderApiToken: step?.extractHeaders?.apiToken ?? '',
  extractHeaderApiKey: step?.extractHeaders?.apiKey ?? '',
  extractHeaderCsrfToken: step?.extractHeaders?.csrfToken ?? '',
  extractHeaderSessionCookie: step?.extractHeaders?.sessionCookie ?? '',
  extractCookieName: step?.extractCookieName ?? ''
});

const draftToStep = (draft: SetupStepDraft): RuntimeSetupStep => {
  const extractJsonPaths = {
    apiToken: draft.extractJsonApiToken.trim(),
    apiKey: draft.extractJsonApiKey.trim(),
    csrfToken: draft.extractJsonCsrfToken.trim(),
    sessionCookie: draft.extractJsonSessionCookie.trim()
  };
  const extractHeaders = {
    apiToken: draft.extractHeaderApiToken.trim(),
    apiKey: draft.extractHeaderApiKey.trim(),
    csrfToken: draft.extractHeaderCsrfToken.trim(),
    sessionCookie: draft.extractHeaderSessionCookie.trim()
  };

  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    method: draft.method.trim().toUpperCase(),
    path: draft.path.trim(),
    headers: parseOptionalJson('Headers', draft.headersText) as Record<string, string> | undefined,
    query: parseOptionalJson('Query', draft.queryText) as Record<string, unknown> | undefined,
    body: parseOptionalJson('Body', draft.bodyText),
    expectedStatus: draft.expectedStatus.trim() ? Number(draft.expectedStatus.trim()) : undefined,
    extractJsonPaths: Object.values(extractJsonPaths).some(Boolean) ? extractJsonPaths : undefined,
    extractHeaders: Object.values(extractHeaders).some(Boolean) ? extractHeaders : undefined,
    extractCookieName: draft.extractCookieName.trim() || undefined
  };
};

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
  const [runtimeSetupDrafts, setRuntimeSetupDrafts] = useState<SetupStepDraft[]>([]);
  const [runtimeSetupInput, setRuntimeSetupInput] = useState('[]');
  const [runtimeSetupError, setRuntimeSetupError] = useState('');

  const selectedProvider = appState?.settings.provider ?? 'openai';
  const availableModels = PROVIDER_MODELS[selectedProvider];
  const selectedProviderKey =
    selectedProvider === 'openai'
      ? appState?.settings.openAiKey ?? ''
      : selectedProvider === 'claude'
        ? appState?.settings.claudeKey ?? ''
        : appState?.settings.geminiKey ?? '';
  const [apiKeyInput, setApiKeyInput] = useState(selectedProviderKey);

  useEffect(() => {
    setApiKeyInput(selectedProviderKey);
    setKeyWarning('');
  }, [selectedProvider, selectedProviderKey]);

  useEffect(() => {
    const nextDrafts = (appState?.settings.runtimeSetupSteps ?? []).map((step) => createDraftFromStep(step));
    setRuntimeSetupDrafts(nextDrafts);
    setRuntimeSetupInput(JSON.stringify(appState?.settings.runtimeSetupSteps ?? [], null, 2));
    setRuntimeSetupError('');
  }, [appState?.settings.runtimeSetupSteps]);

  const persistRuntimeSetupDrafts = (nextDrafts: SetupStepDraft[]) => {
    setRuntimeSetupDrafts(nextDrafts);
    try {
      const parsed = nextDrafts.map((draft) => draftToStep(draft));
      onPatchSettings({ runtimeSetupSteps: parsed });
      setRuntimeSetupInput(JSON.stringify(parsed, null, 2));
      setRuntimeSetupError('');
    } catch (error) {
      setRuntimeSetupError(error instanceof Error ? error.message : 'Invalid setup step values.');
    }
  };

  const updateRuntimeSetupDraft = (index: number, patch: Partial<SetupStepDraft>) => {
    const nextDrafts = runtimeSetupDrafts.map((draft, draftIndex) => (
      draftIndex === index ? { ...draft, ...patch } : draft
    ));
    persistRuntimeSetupDrafts(nextDrafts);
  };

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
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
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
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.validateGeneratedTests ?? true}
              onChange={(event) => onPatchSettings({ validateGeneratedTests: event.target.checked })}
            />
            Validate generated tests against Base URL before packaging
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.autoRepairFailingTests ?? true}
              onChange={(event) => onPatchSettings({ autoRepairFailingTests: event.target.checked })}
            />
            Auto-repair tests that fail live validation
          </label>
          <label>
            Validation Repair Rounds
            <input
              type="number"
              min={0}
              max={5}
              value={appState?.settings.maxValidationRepairs ?? 2}
              onChange={(event) => onPatchSettings({ maxValidationRepairs: Number(event.target.value) })}
            />
          </label>
          <div className="grid two">
            <label>
              Runtime Auth Mode
              <select
                value={appState?.settings.runtimeAuthMode ?? 'none'}
                onChange={(event) => onPatchSettings({ runtimeAuthMode: event.target.value as AppState['settings']['runtimeAuthMode'] })}
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="apiKey">API key</option>
                <option value="cookieSession">Cookie session</option>
                <option value="oauth2">OAuth2 bearer</option>
              </select>
            </label>
            <label>
              API Key Header Name
              <input
                type="text"
                value={appState?.settings.apiKeyHeaderName ?? 'X-API-Key'}
                onChange={(event) => onPatchSettings({ apiKeyHeaderName: event.target.value.trim() })}
                placeholder="X-API-Key"
              />
            </label>
            <label>
              Session Cookie Name
              <input
                type="text"
                value={appState?.settings.sessionCookieName ?? ''}
                onChange={(event) => onPatchSettings({ sessionCookieName: event.target.value.trim() })}
                placeholder="session"
              />
            </label>
            <label>
              CSRF Header Name
              <input
                type="text"
                value={appState?.settings.csrfHeaderName ?? 'X-CSRF-Token'}
                onChange={(event) => onPatchSettings({ csrfHeaderName: event.target.value.trim() })}
                placeholder="X-CSRF-Token"
              />
            </label>
          </div>

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
          <div className="grid two">
            <label>
              Runtime API Token
              <input
                type="password"
                value={appState?.settings.runtimeApiToken ?? ''}
                onChange={(event) => onPatchSettings({ runtimeApiToken: event.target.value.trim() })}
                placeholder="Used only for live validation"
              />
            </label>
            <label>
              Runtime API Key
              <input
                type="password"
                value={appState?.settings.runtimeApiKey ?? ''}
                onChange={(event) => onPatchSettings({ runtimeApiKey: event.target.value.trim() })}
                placeholder="Used only for live validation"
              />
            </label>
            <label>
              Runtime Session Cookie
              <input
                type="password"
                value={appState?.settings.runtimeSessionCookie ?? ''}
                onChange={(event) => onPatchSettings({ runtimeSessionCookie: event.target.value.trim() })}
                placeholder="session=..."
              />
            </label>
            <label>
              Runtime CSRF Token
              <input
                type="password"
                value={appState?.settings.runtimeCsrfToken ?? ''}
                onChange={(event) => onPatchSettings({ runtimeCsrfToken: event.target.value.trim() })}
                placeholder="Used only for live validation"
              />
            </label>
          </div>
          <div className="settings-group">
            <h3>Validation Setup Flow</h3>
            <p className="subtle">
              Build setup steps for login, token exchange, CSRF bootstrap, or prerequisite resource creation before live validation runs.
            </p>
            <div className="grid two">
              <button
                type="button"
                className="ghost utility-btn"
                onClick={() => persistRuntimeSetupDrafts([...runtimeSetupDrafts, createDraftFromStep()])}
              >
                Add Login Step
              </button>
              <button
                type="button"
                className="ghost utility-btn"
                onClick={() => persistRuntimeSetupDrafts([
                  ...runtimeSetupDrafts,
                  createDraftFromStep({
                    id: `setup-${Date.now()}`,
                    name: 'Seed Fixture',
                    method: 'POST',
                    path: '/test/seed',
                    expectedStatus: 201
                  })
                ])}
              >
                Add Fixture Step
              </button>
            </div>
            {runtimeSetupDrafts.length === 0 ? (
              <p className="subtle">No setup steps configured.</p>
            ) : null}
            {runtimeSetupDrafts.map((draft, index) => (
              <div key={draft.id || `draft-${index}`} className="panel">
                <div className="grid two">
                  <label>
                    Step Name
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(event) => updateRuntimeSetupDraft(index, { name: event.target.value })}
                      placeholder="Login"
                    />
                  </label>
                  <label>
                    Step ID
                    <input
                      type="text"
                      value={draft.id}
                      onChange={(event) => updateRuntimeSetupDraft(index, { id: event.target.value })}
                      placeholder="login"
                    />
                  </label>
                  <label>
                    Method
                    <select
                      value={draft.method}
                      onChange={(event) => updateRuntimeSetupDraft(index, { method: event.target.value })}
                    >
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                        <option key={method} value={method}>{method}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Path
                    <input
                      type="text"
                      value={draft.path}
                      onChange={(event) => updateRuntimeSetupDraft(index, { path: event.target.value })}
                      placeholder="/auth/login"
                    />
                  </label>
                  <label>
                    Expected Status
                    <input
                      type="number"
                      min={100}
                      max={599}
                      value={draft.expectedStatus}
                      onChange={(event) => updateRuntimeSetupDraft(index, { expectedStatus: event.target.value })}
                    />
                  </label>
                  <label>
                    Extract Cookie Name
                    <input
                      type="text"
                      value={draft.extractCookieName}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractCookieName: event.target.value })}
                      placeholder="session"
                    />
                  </label>
                </div>
                <div className="grid two">
                  <label>
                    Headers JSON
                    <textarea
                      className="spec-input"
                      rows={4}
                      value={draft.headersText}
                      onChange={(event) => updateRuntimeSetupDraft(index, { headersText: event.target.value })}
                      placeholder='{"Content-Type":"application/json"}'
                    />
                  </label>
                  <label>
                    Query JSON
                    <textarea
                      className="spec-input"
                      rows={4}
                      value={draft.queryText}
                      onChange={(event) => updateRuntimeSetupDraft(index, { queryText: event.target.value })}
                      placeholder='{"workspace":"qa"}'
                    />
                  </label>
                </div>
                <label>
                  Body JSON
                  <textarea
                    className="spec-input"
                    rows={4}
                    value={draft.bodyText}
                    onChange={(event) => updateRuntimeSetupDraft(index, { bodyText: event.target.value })}
                    placeholder='{"email":"qa@example.com","password":"secret"}'
                  />
                </label>
                <div className="grid two">
                  <label>
                    JSON Path: API Token
                    <input
                      type="text"
                      value={draft.extractJsonApiToken}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractJsonApiToken: event.target.value })}
                      placeholder="token"
                    />
                  </label>
                  <label>
                    JSON Path: API Key
                    <input
                      type="text"
                      value={draft.extractJsonApiKey}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractJsonApiKey: event.target.value })}
                      placeholder="credentials.apiKey"
                    />
                  </label>
                  <label>
                    JSON Path: CSRF Token
                    <input
                      type="text"
                      value={draft.extractJsonCsrfToken}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractJsonCsrfToken: event.target.value })}
                      placeholder="csrf.token"
                    />
                  </label>
                  <label>
                    JSON Path: Session Cookie Value
                    <input
                      type="text"
                      value={draft.extractJsonSessionCookie}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractJsonSessionCookie: event.target.value })}
                      placeholder="session.value"
                    />
                  </label>
                  <label>
                    Header: API Token
                    <input
                      type="text"
                      value={draft.extractHeaderApiToken}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractHeaderApiToken: event.target.value })}
                      placeholder="x-api-token"
                    />
                  </label>
                  <label>
                    Header: API Key
                    <input
                      type="text"
                      value={draft.extractHeaderApiKey}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractHeaderApiKey: event.target.value })}
                      placeholder="x-api-key"
                    />
                  </label>
                  <label>
                    Header: CSRF Token
                    <input
                      type="text"
                      value={draft.extractHeaderCsrfToken}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractHeaderCsrfToken: event.target.value })}
                      placeholder="x-csrf-token"
                    />
                  </label>
                  <label>
                    Header: Session Cookie Value
                    <input
                      type="text"
                      value={draft.extractHeaderSessionCookie}
                      onChange={(event) => updateRuntimeSetupDraft(index, { extractHeaderSessionCookie: event.target.value })}
                      placeholder="set-cookie"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="ghost utility-btn"
                  onClick={() => persistRuntimeSetupDrafts(runtimeSetupDrafts.filter((_, draftIndex) => draftIndex !== index))}
                >
                  Remove Step
                </button>
              </div>
            ))}
            <label>
              Advanced JSON Editor
              <textarea
                className="spec-input"
                rows={8}
                value={runtimeSetupInput}
                onChange={(event) => {
                  setRuntimeSetupInput(event.target.value);
                  setRuntimeSetupError('');
                }}
                onBlur={() => {
                  try {
                    const parsed = JSON.parse(runtimeSetupInput);
                    if (!Array.isArray(parsed)) {
                      throw new Error('Setup flow must be a JSON array.');
                    }
                    const nextDrafts = parsed.map((step) => createDraftFromStep(step as RuntimeSetupStep));
                    setRuntimeSetupDrafts(nextDrafts);
                    onPatchSettings({ runtimeSetupSteps: parsed as RuntimeSetupStep[] });
                    setRuntimeSetupError('');
                  } catch (error) {
                    setRuntimeSetupError(error instanceof Error ? error.message : 'Invalid setup flow JSON.');
                  }
                }}
                placeholder={`[
  {
    "id": "login",
    "name": "Login",
    "method": "POST",
    "path": "/auth/login",
    "body": { "email": "qa@example.com", "password": "secret" },
    "extractJsonPaths": { "apiToken": "token" },
    "expectedStatus": 200
  }
]`}
              />
            </label>
            {runtimeSetupError ? <small className="key-warning">{runtimeSetupError}</small> : null}
            <small className="subtle">
              Runtime setup flows are excluded from settings export.
            </small>
          </div>
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
          <p className="subtle">Provider keys and runtime validation secrets/setup flows are excluded from export.</p>
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
