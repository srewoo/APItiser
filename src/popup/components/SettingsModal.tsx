import { useEffect, useState } from 'react';
import { PROVIDER_MODELS } from '@shared/constants';
import type { AppState, TestCategory } from '@shared/types';
import type { LocalRunnerStatus } from '@shared/messages';

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
  onOpenDoc: (path: 'help.html' | 'privacypolicy.html') => void;
  onExportSettings: () => void;
  onImportSettings: (file: File | null | undefined) => void;
  onDownloadRunner: () => void;
  onCheckLocalRunner: () => void;
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
  runnerCheck,
}: SettingsModalProps) {
  const [keyWarning, setKeyWarning] = useState('');
  const [hostCmdCopied, setHostCmdCopied] = useState(false);

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
  const availableModels = PROVIDER_MODELS[selectedProvider];
  const selectedModel = appState?.settings.model ?? availableModels[0];
  // Mirrors background/llm/modelCapabilities — reasoning models reject a temperature value.
  const isReasoningModel =
    (selectedProvider === 'openai' && (/^o\d/i.test(selectedModel) || /^gpt-5/i.test(selectedModel)))
    || (selectedProvider === 'claude' && /claude-(opus-4|sonnet-4-6|haiku-4|fable-5|mythos)/i.test(selectedModel));
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

            <label>
              Local Repo Path
              <input
                type="text"
                value={appState?.settings.localRepoPath ?? ''}
                onChange={(event) => onPatchSettings({ localRepoPath: event.target.value.trim() })}
                placeholder="/Users/you/code/my-api"
              />
            </label>
            <div className="grid two">
              <label>
                Local Run Port
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={appState?.settings.localRunPort ?? 8080}
                  onChange={(event) => onPatchSettings({ localRunPort: Number(event.target.value) })}
                />
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
          </div>
        </div>
      </section>
    </div>
  );
}
