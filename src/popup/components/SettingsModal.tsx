import { useEffect, useState } from 'react';
import { PROVIDER_MODELS, DEFAULT_OPENAI_BASE_URL } from '@shared/constants';
import type { AppState, RuntimeSetupStep, TestCategory } from '@shared/types';
import type { LocalRunnerStatus, ProviderKeyStatus } from '@shared/messages';
import { isReasoningModel as modelRejectsTemperature } from '@background/llm/modelCapabilities';
import { pickModel } from '@background/llm/modelList';
import {
  PROVIDER_CHOICES,
  localPresetFor,
  providerChoiceOf,
  settingsForChoice,
  usesLocalLlm,
  type ProviderChoice
} from '@shared/localLlm';

type KeyProvider = 'openai' | 'claude' | 'gemini';

const API_KEY_PATTERNS: Record<KeyProvider, { prefix: string; minLength: number }> = {
  openai: { prefix: 'sk-', minLength: 40 },
  claude: { prefix: 'sk-ant-', minLength: 50 },
  gemini: { prefix: 'AIza', minLength: 36 }
};

const RUNTIME_TOKEN_RE = /\{\{(\w+)\}\}/g;

/**
 * Collect the distinct `{{NAME}}` placeholders that appear anywhere in the generated suite
 * (paths, headers, query, body). These are the values a user must seed via Runtime Values (or
 * a setup step's extractValues) for live validation to resolve them to real ids.
 */
const collectRuntimeTokens = (appState: AppState | null): string[] => {
  const job = appState?.activeJob ?? appState?.jobHistory?.[0];
  const tests = job?.generatedTests ?? [];
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (value == null) return;
    if (typeof value === 'string') {
      for (const match of value.matchAll(RUNTIME_TOKEN_RE)) {
        found.add(match[1]);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        scan(nested);
      }
    }
  };
  for (const test of tests) {
    scan(test.request.path);
    scan(test.request.headers);
    scan(test.request.query);
    scan(test.request.body);
  }
  return [...found].sort();
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
  onOpenDoc: (path: 'help.html' | 'privacypolicy.html' | 'token-check.html') => void;
  onExportSettings: () => void;
  onImportSettings: (file: File | null | undefined) => void;
  onDownloadRunner: () => void;
  onCheckLocalRunner: () => void;
  onTestKey: (
    provider: 'openai' | 'claude' | 'gemini',
    apiKey: string,
    baseUrl?: string
  ) => Promise<ProviderKeyStatus>;
  /** Native folder dialog (via the local runner). */
  onPickFolder: (prompt?: string) => Promise<{ path?: string; cancelled?: boolean }>;
  runnerCheck: { checking: boolean; result?: LocalRunnerStatus };
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
  onDownloadRunner,
  onCheckLocalRunner,
  onTestKey,
  onPickFolder,
  runnerCheck,
}: SettingsModalProps) {
  const [keyWarning, setKeyWarning] = useState('');
  const [hostCmdCopied, setHostCmdCopied] = useState(false);
  const [keyTest, setKeyTest] = useState<{ testing: boolean; result?: { ok: boolean; message: string } }>({ testing: false });

  // The host install must allow this exact extension; chrome.runtime.id is the published
  // Web Store ID in production and the unpacked dev ID otherwise — either way it's correct.
  const extensionId =
    typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : 'YOUR_EXTENSION_ID';
  const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  // Run from whatever folder contains the installer — the unzipped local-runner download, or
  // the APItiser repo's native-host/ folder for users who cloned it.
  const installCommand = isWindows
    ? `powershell -ExecutionPolicy Bypass -File .\\install.ps1 ${extensionId}`
    : `./install.sh ${extensionId}`;
  const copyInstallCommand = (): void => {
    void navigator.clipboard
      ?.writeText(installCommand)
      .then(() => {
        setHostCmdCopied(true);
        setTimeout(() => setHostCmdCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  const selectedProvider = appState?.settings.provider ?? 'openai';
  // Models discovered with the user's key win over the built-in suggestions.
  const providerChoice: ProviderChoice = appState ? providerChoiceOf(appState.settings) : 'openai';
  const discoveredModels = appState?.settings.availableModels?.[providerChoice] ?? [];
  const availableModels = discoveredModels.length ? discoveredModels : PROVIDER_MODELS[selectedProvider];
  const selectedModel = appState?.settings.model ?? availableModels[0];
  const isReasoningModel = modelRejectsTemperature(selectedProvider, selectedModel);
  const selectedProviderKey =
    selectedProvider === 'openai'
      ? appState?.settings.openAiKey ?? ''
      : selectedProvider === 'claude'
        ? appState?.settings.claudeKey ?? ''
        : appState?.settings.geminiKey ?? '';
  const [apiKeyInput, setApiKeyInput] = useState(selectedProviderKey);
  const localLlm = Boolean(appState && usesLocalLlm(appState.settings));
  const [folderError, setFolderError] = useState('');
  const browseInto = async (field: 'cloneRoot' | 'cloneSearchRoots'): Promise<void> => {
    setFolderError('');
    try {
      const picked = await onPickFolder(field === 'cloneRoot' ? 'Choose where APItiser should clone repos' : 'Choose a folder to search for clones');
      if (picked.cancelled || !picked.path) return;
      if (field === 'cloneRoot') {
        onPatchSettings({ cloneRoot: picked.path });
      } else {
        const current = appState?.settings.cloneSearchRoots ?? [];
        if (!current.includes(picked.path)) onPatchSettings({ cloneSearchRoots: [...current, picked.path] });
      }
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : 'Could not open the folder picker — type the path instead.');
    }
  };
  const localPreset = localPresetFor(providerChoice);

  useEffect(() => {
    setApiKeyInput(selectedProviderKey);
    setKeyWarning('');
    setKeyTest({ testing: false });
  }, [providerChoice, selectedProviderKey]);

  const runKeyTest = async (key = apiKeyInput.trim()): Promise<void> => {
    setKeyTest({ testing: true });
    const result = await onTestKey(
      selectedProvider as KeyProvider,
      key,
      selectedProvider === 'openai' ? appState?.settings.openAiBaseUrl : undefined
    );
    setKeyTest({ testing: false, result });
    if (result.ok && result.models?.length) {
      onPatchSettings({
        availableModels: { ...appState?.settings.availableModels, [providerChoice]: result.models },
        model: pickModel(result.models, appState?.settings.model, PROVIDER_MODELS[selectedProvider])
      });
    }
  };

  // Load the account's models once per provider/key/base URL when none are known yet.
  const modelSource = `${selectedProvider}|${selectedProviderKey}|${appState?.settings.openAiBaseUrl ?? ''}`;
  const [modelSourceLoaded, setModelSourceLoaded] = useState('');
  useEffect(() => {
    if (!appState || modelSourceLoaded === modelSource) return;
    if (!selectedProviderKey && !localLlm) return;
    // Debounced: the base URL field saves on every keystroke.
    const timer = setTimeout(() => {
      setModelSourceLoaded(modelSource);
      void runKeyTest(localLlm ? '' : selectedProviderKey);
    }, 600);
    return () => clearTimeout(timer);
  }, [modelSource]);

  // Runtime values are edited as an ordered list of pairs so a blank key can be typed before
  // its value; the settings record is rebuilt (dropping blank keys) on every change.
  const [runtimePairs, setRuntimePairs] = useState<Array<{ key: string; value: string }>>([]);
  useEffect(() => {
    const values = appState?.settings.runtimeValues ?? {};
    setRuntimePairs(Object.entries(values).map(([key, value]) => ({ key, value })));
  }, [appState?.settings.runtimeValues]);

  const persistRuntimePairs = (pairs: Array<{ key: string; value: string }>): void => {
    const record: Record<string, string> = {};
    for (const { key, value } of pairs) {
      const trimmed = key.trim();
      if (trimmed) record[trimmed] = value;
    }
    onPatchSettings({ runtimeValues: record });
  };

  const authMode = appState?.settings.runtimeAuthMode ?? 'none';
  const discoveredTokens = collectRuntimeTokens(appState);

  // Setup steps run before validation (e.g. a login that extracts a token). Edited locally and
  // persisted on change; the body is edited as JSON text and parsed leniently.
  const [setupSteps, setSetupSteps] = useState<RuntimeSetupStep[]>([]);
  useEffect(() => {
    setSetupSteps(appState?.settings.runtimeSetupSteps ?? []);
  }, [appState?.settings.runtimeSetupSteps]);

  const persistSteps = (steps: RuntimeSetupStep[]): void => {
    onPatchSettings({ runtimeSetupSteps: steps });
  };
  const updateStep = (index: number, patch: Partial<RuntimeSetupStep>): void => {
    const next = setupSteps.map((step, i) => (i === index ? { ...step, ...patch } : step));
    setSetupSteps(next);
    persistSteps(next);
  };
  const addStep = (): void => {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `step-${setupSteps.length + 1}`;
    const next = [...setupSteps, { id, name: 'Login', method: 'POST', path: '/auth/login', expectedStatus: 200 }];
    setSetupSteps(next);
    persistSteps(next);
  };
  const removeStep = (index: number): void => {
    const next = setupSteps.filter((_, i) => i !== index);
    setSetupSteps(next);
    persistSteps(next);
  };
  const seededNames = new Set(runtimePairs.map((p) => p.key.trim()).filter(Boolean));
  // Tokens the suite handles on its own via secondary-identity auth — not user-seeded.
  const AUTO_TOKENS = new Set(['API_TOKEN_SECONDARY']);

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
                value={providerChoice}
                onChange={(event) => onPatchSettings(settingsForChoice(event.target.value as ProviderChoice))}
              >
                {PROVIDER_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
            </label>
            <label>
              Model
              {selectedProvider === 'openai' ? (
                <>
                  <input
                    type="text"
                    list="openai-model-list"
                    value={appState?.settings.model ?? availableModels[0]}
                    onChange={(event) => onPatchSettings({ model: event.target.value })}
                    placeholder={localLlm ? 'Model name your server has loaded' : 'gpt-5 or another OpenAI model'}
                  />
                  <datalist id="openai-model-list">
                    {availableModels.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </>
              ) : (
                <select
                  value={selectedModel}
                  onChange={(event) => onPatchSettings({ model: event.target.value })}
                >
                  {(availableModels.includes(selectedModel) ? availableModels : [selectedModel, ...availableModels]).map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              )}
              <small className="subtle">
                {discoveredModels.length
                  ? `${discoveredModels.length} model${discoveredModels.length === 1 ? '' : 's'} available on your ${localLlm ? 'local server' : 'account'}.`
                  : localLlm
                    ? 'Start your server, then Test connection to list its models.'
                    : 'Suggested models — add a key to load the ones your account can use.'}
              </small>
            </label>
          </div>
          {localLlm ? (
            <label>
              Server URL
              <input
                key={`server-${providerChoice}`}
                type="text"
                defaultValue={appState?.settings.openAiBaseUrl ?? ''}
                onBlur={(event) => onPatchSettings({ openAiBaseUrl: event.target.value.trim() || localPreset?.baseUrl })}
                placeholder={localPreset?.baseUrl}
              />
              <small className="subtle">
                Runs on your machine — no API key needed, and your code never leaves your computer.
                {localPreset ? <> Setup: <code>{localPreset.hint}</code>.</> : null} Small models write weaker
                tests; 7B+ coder models work best.
              </small>
            </label>
          ) : selectedProvider === 'openai' ? (
            <label>
              Base URL (optional)
              <input
                key={`base-${providerChoice}`}
                type="text"
                defaultValue={appState?.settings.openAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL}
                onBlur={(event) => onPatchSettings({ openAiBaseUrl: event.target.value.trim() || DEFAULT_OPENAI_BASE_URL })}
                placeholder={DEFAULT_OPENAI_BASE_URL}
              />
              <small className="subtle">
                Only change this for a gateway or proxy; <code>/v1/chat/completions</code> is added automatically.
                For a model on your machine, pick a <em>(local)</em> provider above.
              </small>
            </label>
          ) : null}
          {localLlm ? null : (
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
          )}
          <div className="cmd-row">
            <button
              type="button"
              className="ghost utility-btn"
              onClick={() => void runKeyTest(localLlm ? '' : apiKeyInput.trim())}
              disabled={keyTest.testing || (!apiKeyInput.trim() && !localLlm)}
            >
              {keyTest.testing ? 'Testing…' : localLlm ? 'Test connection' : 'Test key'}
            </button>
            {keyTest.result ? (
              <span className={keyTest.result.ok ? 'check-ok' : 'check-bad'}>
                {keyTest.result.ok ? '✓ ' : '✗ '}
                {keyTest.result.message}
              </span>
            ) : null}
          </div>
          <label>
            Temperature{isReasoningModel ? ' (ignored for reasoning models)' : ''}
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              disabled={isReasoningModel}
              value={isReasoningModel ? '' : appState?.settings.temperature ?? 0.2}
              placeholder={isReasoningModel ? 'n/a — model controls this' : '0.2'}
              onChange={(event) => onPatchSettings({ temperature: Number(event.target.value) })}
            />
            <small className="subtle">
              {isReasoningModel
                ? 'This model reasons internally and rejects a temperature value, so APItiser omits it automatically.'
                : 'Lower = more deterministic tests (0.2 recommended). Reasoning models ignore this.'}
            </small>
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
                <option value="supertest">Jest + Supertest</option>
                <option value="mocha">Mocha + Chai</option>
                <option value="pytest">Pytest</option>
                <option value="gotest">Go (testing)</option>
                <option value="restassured">JUnit5 + REST Assured</option>
                <option value="vitest">Vitest</option>
                <option value="playwright">Playwright (API)</option>
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
                aria-pressed={appState?.settings.includeCategories.includes(category) ?? false}
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
          <div className="settings-group">
            <h3>Local Runner</h3>
            <p className="subtle">
              Boot the repo&apos;s service automatically (via runLocal) and validate the generated
              suite against it — no need to start the service by hand.
            </p>

            <details className="local-runner-help">
              <summary>How to run tests locally (one-time setup)</summary>
              <div className="local-runner-help-body">
                <p className="subtle">
                  A browser extension can&apos;t start a service on its own, so APItiser uses a small
                  local helper (a Chrome <em>native messaging host</em>) that runs <code>runLocal</code>
                  for you. You install it once per machine — after that, &quot;Run Locally&quot; is one click.
                </p>
                <p className="subtle">Without it you can still generate, download, and validate against a server you start yourself.</p>
                <ol className="local-runner-steps">
                  <li>
                    Prerequisites: <strong>Node.js</strong> and <strong>git</strong> on your PATH, and the
                    repo you want to test cloned locally.
                    {isWindows ? ' On Windows also install Git for Windows (it provides the bash runLocal needs).' : ''}
                  </li>
                  <li>
                    Download the APItiser local runner (the host + installer + <code>runLocal</code>, served by
                    this extension) and unzip it. <strong>Unzip it somewhere outside <code>~/Downloads</code></strong>
                    {' '}(e.g. your home folder) — macOS blocks Chrome from launching files in Downloads/Desktop/Documents.
                    The installer then copies it to <code>~/.apitiser/runner</code> for you.
                    <div className="cmd-row">
                      <button type="button" className="utility-btn link-download" onClick={onDownloadRunner}>
                        Download local runner
                      </button>
                    </div>
                  </li>
                  <li>
                    From the unzipped folder, register the helper (locked to this extension&apos;s ID):
                    <div className="cmd-row">
                      <code className="cmd">{installCommand}</code>
                      <button type="button" className="ghost utility-btn" onClick={copyInstallCommand}>
                        {hostCmdCopied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <span className="subtle">Extension ID: <code>{extensionId}</code>. (Cloned the repo instead? The runner is its <code>native-host/</code> folder.)</span>
                  </li>
                  <li>Set the <strong>local repo path</strong> below, enable &quot;Run Locally&quot;, and save.</li>
                  <li>Generate tests, then click <strong>Run Locally</strong> on the main screen.</li>
                </ol>
                <p className="subtle runner-note">
                  <strong>Handled for you:</strong> the runner auto-starts <strong>Docker</strong> for
                  container/compose repos, auto-detects the app&apos;s <strong>port</strong> from
                  <code> docker-compose.yml</code>, and installs the service, suite, and Python-venv
                  dependencies at run time. You only need the base tools <em>installed</em>
                  (Docker / Node / Python as your repo requires) — the runner can&apos;t install those.
                  Set <strong>Local Run Port</strong> only to override the auto-detected one.
                </p>
                <p className="subtle">
                  Windows uses a registry entry instead of <code>install.sh</code> — see the bundled
                  <code> INSTALL.md</code> for the exact steps and troubleshooting.
                </p>
              </div>
            </details>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={appState?.settings.enableLocalRunner ?? false}
                onChange={(event) => onPatchSettings({ enableLocalRunner: event.target.checked })}
              />
              Enable &quot;Run Locally&quot;
            </label>

            <button type="button" className="ghost utility-btn" onClick={onCheckLocalRunner} disabled={runnerCheck.checking}>
              {runnerCheck.checking ? 'Checking…' : 'Check setup'}
            </button>
            {runnerCheck.result ? (
              <div className="runner-check">
                <p className={runnerCheck.result.hostOk ? 'check-ok' : 'check-bad'}>
                  {runnerCheck.result.hostOk
                    ? '✓ Native host reachable — local runs are ready.'
                    : `✗ Native host not reachable: ${runnerCheck.result.hostMessage ?? 'unknown error'}`}
                </p>
                {!runnerCheck.result.hostOk ? (
                  <p className="subtle">Install/re-install the runner above, then check again.</p>
                ) : null}
                <p className="subtle">{runnerCheck.result.serviceMessage}</p>
              </div>
            ) : null}

            <p className="subtle">
              The folder each repo runs from is set per repo under <strong>Run in Browser → Code → Change</strong>.
              By default Start finds your existing clone, or clones the repo for you.
            </p>
            {appState?.settings.localRepoPath ? (
              <p className="settings-warn">
                Legacy repo path <code>{appState.settings.localRepoPath}</code> — only used for the repo it&apos;s a clone
                of. Prefer the per-repo folder.{' '}
                <button type="button" className="link-btn" onClick={() => onPatchSettings({ localRepoPath: '' })}>
                  Clear
                </button>
              </p>
            ) : null}
            <label>
              Clone repos into
              <input
                key={`clone-root-${appState?.settings.cloneRoot ?? ''}`}
                type="text"
                defaultValue={appState?.settings.cloneRoot ?? ''}
                placeholder="~/.apitiser/repos (default)"
                onBlur={(event) => onPatchSettings({ cloneRoot: event.target.value.trim() })}
              />
              <small className="subtle">
                Repos not on your computer yet are cloned here (e.g. <code>~/code</code>) — and found here next time.
              </small>
            </label>
            <button type="button" className="ghost utility-btn" onClick={() => void browseInto('cloneRoot')}>
              Browse…
            </button>
            <label>
              Also search these folders
              <textarea
                key={`search-roots-${(appState?.settings.cloneSearchRoots ?? []).join('|')}`}
                rows={2}
                defaultValue={(appState?.settings.cloneSearchRoots ?? []).join('\n')}
                placeholder="~/Documents/GitHub (one folder per line)"
                onBlur={(event) =>
                  onPatchSettings({
                    cloneSearchRoots: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
                  })
                }
              />
              <small className="subtle">
                Start already searches your home folder (3 levels deep) except Desktop, Documents and Downloads. Folders
                listed here are searched too; macOS may ask once for permission to read them.
              </small>
            </label>
            <button type="button" className="ghost utility-btn" onClick={() => void browseInto('cloneSearchRoots')}>
              Add folder…
            </button>
            {folderError ? <p className="settings-warn">{folderError}</p> : null}
            <div className="grid two">
              <label>
                Local Run Port
                <input
                  type="number"
                  min={0}
                  max={65535}
                  placeholder="Auto (free port)"
                  value={appState?.settings.localRunPort || ''}
                  onChange={(event) => onPatchSettings({ localRunPort: Number(event.target.value) || 0 })}
                />
                <small className="subtle">Leave blank to use a free port. A busy port falls back to a free one.</small>
              </label>
              <label>
                Boot Timeout (ms)
                <input
                  type="number"
                  min={10000}
                  step={10000}
                  value={appState?.settings.localRunBootTimeoutMs ?? 180000}
                  onChange={(event) => onPatchSettings({ localRunBootTimeoutMs: Number(event.target.value) })}
                />
              </label>
            </div>
            <label>
              runLocal Script Path (optional)
              <input
                type="text"
                value={appState?.settings.runLocalScriptPath ?? ''}
                onChange={(event) => onPatchSettings({ runLocalScriptPath: event.target.value.trim() })}
                placeholder="Auto-detected if runLocal/ sits next to APItiser"
              />
            </label>
            <div className="grid two">
              <label>
                Run Command Override (optional)
                <input
                  type="text"
                  value={appState?.settings.localRunCmd ?? ''}
                  onChange={(event) => onPatchSettings({ localRunCmd: event.target.value })}
                  placeholder="e.g. npm run start:dev"
                />
              </label>
              <label>
                Stack Override (optional)
                <input
                  type="text"
                  value={appState?.settings.localRunStack ?? ''}
                  onChange={(event) => onPatchSettings({ localRunStack: event.target.value.trim() })}
                  placeholder="node | python | go | …"
                />
              </label>
            </div>
            <label>
              Test Command Override (optional)
              <input
                type="text"
                value={appState?.settings.localTestCommand ?? ''}
                onChange={(event) => onPatchSettings({ localTestCommand: event.target.value })}
                placeholder="Used by 'Run Repo Tests'. Auto-detected (pytest / npm test / go test / …) if blank."
              />
            </label>
          </div>
        </div>

        {/* Live Validation */}
        <div className="settings-group">
          <h3>Live Validation</h3>
          <p className="subtle">
            Optionally execute the generated suite against a running instance of the API before
            packaging, then auto-repair anything that fails. The Base URL is also injected into
            downloaded test files, so it is worth setting even if you don&apos;t validate here.
          </p>
          <label>
            Base URL
            <input
              type="text"
              value={appState?.settings.baseUrl ?? ''}
              onChange={(event) => onPatchSettings({ baseUrl: event.target.value.trim() })}
              placeholder="http://localhost:3000"
            />
            <small className="subtle">A base path is preserved — e.g. <code>https://api.example.com/v1</code>.</small>
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.validateGeneratedTests ?? false}
              onChange={(event) => onPatchSettings({ validateGeneratedTests: event.target.checked })}
            />
            Validate generated tests against the Base URL
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.allowRemoteLiveTests ?? false}
              onChange={(event) => onPatchSettings({ allowRemoteLiveTests: event.target.checked })}
            />
            Allow live tests against non-local URLs
          </label>
          <small className="subtle">
            Live tests send POST/PUT/DELETE and attack-style requests. By default they only run against
            localhost. Enable this only for a disposable staging environment — never production.
          </small>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.autoRepairFailingTests ?? false}
              onChange={(event) => onPatchSettings({ autoRepairFailingTests: event.target.checked })}
            />
            Auto-repair tests that fail live validation
          </label>
          <label>
            Max repair rounds
            <input
              type="number"
              min={0}
              max={5}
              value={appState?.settings.maxValidationRepairs ?? 2}
              onChange={(event) => onPatchSettings({ maxValidationRepairs: Number(event.target.value) })}
            />
          </label>

          <label>
            Auth mode
            <select
              value={appState?.settings.runtimeAuthMode ?? 'none'}
              onChange={(event) =>
                onPatchSettings({ runtimeAuthMode: event.target.value as AppState['settings']['runtimeAuthMode'] })
              }
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="apiKey">API key header</option>
              <option value="cookieSession">Session cookie</option>
              <option value="oauth2">OAuth2 bearer</option>
            </select>
          </label>

          {authMode === 'bearer' || authMode === 'oauth2' ? (
            <label>
              Runtime API / bearer token
              <input
                type="password"
                value={appState?.settings.runtimeApiToken ?? ''}
                onChange={(event) => onPatchSettings({ runtimeApiToken: event.target.value })}
                placeholder="Sent as Authorization: Bearer …"
              />
            </label>
          ) : null}

          {authMode === 'apiKey' ? (
            <div className="grid two">
              <label>
                API key header name
                <input
                  type="text"
                  value={appState?.settings.apiKeyHeaderName ?? 'X-API-Key'}
                  onChange={(event) => onPatchSettings({ apiKeyHeaderName: event.target.value.trim() })}
                  placeholder="X-API-Key"
                />
              </label>
              <label>
                API key value
                <input
                  type="password"
                  value={appState?.settings.runtimeApiKey ?? ''}
                  onChange={(event) => onPatchSettings({ runtimeApiKey: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          {authMode === 'cookieSession' ? (
            <div className="grid two">
              <label>
                Session cookie name
                <input
                  type="text"
                  value={appState?.settings.sessionCookieName ?? ''}
                  onChange={(event) => onPatchSettings({ sessionCookieName: event.target.value.trim() })}
                  placeholder="session"
                />
              </label>
              <label>
                Session cookie value
                <input
                  type="password"
                  value={appState?.settings.runtimeSessionCookie ?? ''}
                  onChange={(event) => onPatchSettings({ runtimeSessionCookie: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          {authMode !== 'none' ? (
            <div className="grid two">
              <label>
                CSRF header name (optional)
                <input
                  type="text"
                  value={appState?.settings.csrfHeaderName ?? 'X-CSRF-Token'}
                  onChange={(event) => onPatchSettings({ csrfHeaderName: event.target.value.trim() })}
                  placeholder="X-CSRF-Token"
                />
              </label>
              <label>
                CSRF token value (optional)
                <input
                  type="password"
                  value={appState?.settings.runtimeCsrfToken ?? ''}
                  onChange={(event) => onPatchSettings({ runtimeCsrfToken: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          {authMode !== 'none' ? (
            <details className="local-runner-help">
              <summary>Second identity (for IDOR / object-level auth tests)</summary>
              <div className="local-runner-help-body">
                <p className="subtle">
                  A lower-privilege / different user used to prove that one user cannot reach
                  another&apos;s resources. Leave blank to downgrade IDOR checks to unauthenticated.
                </p>
                <label>
                  Secondary bearer token
                  <input
                    type="password"
                    value={appState?.settings.runtimeSecondaryApiToken ?? ''}
                    onChange={(event) => onPatchSettings({ runtimeSecondaryApiToken: event.target.value })}
                  />
                </label>
                <label>
                  Secondary API key
                  <input
                    type="password"
                    value={appState?.settings.runtimeSecondaryApiKey ?? ''}
                    onChange={(event) => onPatchSettings({ runtimeSecondaryApiKey: event.target.value })}
                  />
                </label>
                <label>
                  Secondary session cookie
                  <input
                    type="password"
                    value={appState?.settings.runtimeSecondarySessionCookie ?? ''}
                    onChange={(event) => onPatchSettings({ runtimeSecondarySessionCookie: event.target.value })}
                  />
                </label>
              </div>
            </details>
          ) : null}
          <details className="local-runner-help">
            <summary>Setup steps ({setupSteps.length}) — run a login/token exchange before validation</summary>
            <div className="local-runner-help-body">
              <p className="subtle">
                Each step issues a request before the suite runs. Extract a token/cookie from its
                JSON response into a runtime credential (used for auth) or a named{' '}
                <code>{'{{VALUE}}'}</code>. Steps run in order.
              </p>
              {setupSteps.map((step, index) => (
                <div className="settings-group setup-step" key={step.id}>
                  <div className="grid two">
                    <label>
                      Name
                      <input
                        type="text"
                        value={step.name}
                        onChange={(event) => updateStep(index, { name: event.target.value })}
                      />
                    </label>
                    <label>
                      Expected status
                      <input
                        type="number"
                        value={step.expectedStatus ?? 200}
                        onChange={(event) => updateStep(index, { expectedStatus: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  <div className="grid two">
                    <label>
                      Method
                      <select value={step.method} onChange={(event) => updateStep(index, { method: event.target.value })}>
                        {['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Path
                      <input
                        type="text"
                        value={step.path}
                        onChange={(event) => updateStep(index, { path: event.target.value })}
                        placeholder="/auth/login"
                      />
                    </label>
                  </div>
                  <label>
                    Request body (JSON)
                    <textarea
                      className="spec-input"
                      rows={3}
                      defaultValue={step.body === undefined ? '' : JSON.stringify(step.body, null, 2)}
                      placeholder={'{ "email": "qa@example.com", "password": "secret" }'}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        if (!raw) { updateStep(index, { body: undefined }); return; }
                        try { updateStep(index, { body: JSON.parse(raw) }); } catch { /* keep prior on invalid JSON */ }
                      }}
                    />
                  </label>
                  <div className="grid two">
                    <label>
                      Extract bearer token (JSON path)
                      <input
                        type="text"
                        value={step.extractJsonPaths?.apiToken ?? ''}
                        onChange={(event) =>
                          updateStep(index, {
                            extractJsonPaths: { ...step.extractJsonPaths, apiToken: event.target.value.trim() || undefined }
                          })
                        }
                        placeholder="data.token"
                      />
                    </label>
                    <label>
                      Extract session cookie (name)
                      <input
                        type="text"
                        value={step.extractCookieName ?? ''}
                        onChange={(event) => updateStep(index, { extractCookieName: event.target.value.trim() || undefined })}
                        placeholder="connect.sid"
                      />
                    </label>
                  </div>
                  <button type="button" className="ghost utility-btn" onClick={() => removeStep(index)}>
                    Remove step
                  </button>
                </div>
              ))}
              <button type="button" className="ghost utility-btn" onClick={addStep}>
                Add setup step
              </button>
            </div>
          </details>

          <p className="subtle">Validation credentials are secrets — excluded from settings export.</p>
        </div>

        {/* Runtime Values */}
        <div className="settings-group">
          <h3>Runtime Values</h3>
          <p className="subtle">
            Named values used to resolve <code>{'{{NAME}}'}</code> placeholders in generated test
            paths, queries, and bodies during live validation (e.g. <code>USER_ID</code> →{' '}
            <code>42</code>). Generated suites also read these as environment variables, so a real
            id can be injected without editing each test. Values are secrets — masked here and
            excluded from settings export.
          </p>

          {discoveredTokens.length ? (
            <div className="runtime-tokens-discovered">
              <small className="subtle">Tokens found in the current suite:</small>
              <div className="category-row">
                {discoveredTokens.map((name) => {
                  const auto = AUTO_TOKENS.has(name);
                  const seeded = seededNames.has(name);
                  return (
                    <span
                      key={name}
                      className={`chip ${seeded || auto ? 'active' : ''}`}
                      title={
                        auto
                          ? 'Handled automatically via secondary-identity auth'
                          : seeded
                            ? 'Seeded below'
                            : 'Not seeded — add it below or it stays as replace-me'
                      }
                    >
                      {name}
                      {auto ? ' (auto)' : seeded ? ' ✓' : ' ⚠'}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}

          {runtimePairs.map((pair, index) => (
            <div className="grid runtime-value-row" key={`runtime-${index}`}>
              <input
                type="text"
                aria-label="Runtime value name"
                value={pair.key}
                placeholder="USER_ID"
                onChange={(event) => {
                  const next = runtimePairs.map((p, i) =>
                    i === index ? { ...p, key: event.target.value } : p
                  );
                  setRuntimePairs(next);
                }}
                onBlur={() => persistRuntimePairs(runtimePairs)}
              />
              <input
                type="password"
                aria-label="Runtime value"
                value={pair.value}
                placeholder="value"
                onChange={(event) => {
                  const next = runtimePairs.map((p, i) =>
                    i === index ? { ...p, value: event.target.value } : p
                  );
                  setRuntimePairs(next);
                }}
                onBlur={() => persistRuntimePairs(runtimePairs)}
              />
              <button
                type="button"
                className="ghost utility-btn"
                aria-label="Remove runtime value"
                onClick={() => {
                  const next = runtimePairs.filter((_, i) => i !== index);
                  setRuntimePairs(next);
                  persistRuntimePairs(next);
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost utility-btn"
            onClick={() => setRuntimePairs([...runtimePairs, { key: '', value: '' }])}
          >
            Add runtime value
          </button>
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
            <button type="button" className="ghost utility-btn" onClick={() => onOpenDoc('privacypolicy.html')}>
              Privacy Policy
            </button>
            <button type="button" className="ghost utility-btn" onClick={() => onOpenDoc('token-check.html')}>
              Token Checker
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
