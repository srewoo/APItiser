import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PROVIDER_CHOICES,
  isProviderConfigured,
  localPresetFor,
  providerChoiceOf,
  settingsForChoice,
  type ProviderChoice
} from '@shared/localLlm';
import { isLoopbackUrl } from '@shared/localUrl';
import type {
  ExtensionSettings,
  HostPlatform,
  LLMProvider,
  RuntimeAuthMode,
  TestCategory,
  TestFramework
} from '@shared/types';
import type { EventMessage, LocalRunnerStatus } from '@shared/messages';
import { PROVIDER_MODELS } from '@shared/constants';
import { isReasoningModel } from '@background/llm/modelCapabilities';
import { pickModel } from '@background/llm/modelList';
import { sendCommand } from '@popup/runtime';

type KeyTest = { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string };

const PROVIDER_KEY_FIELD: Record<LLMProvider, keyof ExtensionSettings> = {
  openai: 'openAiKey',
  claude: 'claudeKey',
  gemini: 'geminiKey'
};

const FRAMEWORK_LABELS: Record<TestFramework, string> = {
  jest: 'Jest (JS/TS)',
  supertest: 'Jest + Supertest (JS/TS)',
  vitest: 'Vitest (JS/TS)',
  mocha: 'Mocha + Chai (JS/TS)',
  playwright: 'Playwright API (JS/TS)',
  pytest: 'Pytest (Python)',
  restassured: 'JUnit 5 + REST Assured (Java)',
  gotest: 'Go (testing)'
};

const CATEGORIES: Array<{ key: TestCategory; label: string }> = [
  { key: 'positive', label: 'Positive (happy path)' },
  { key: 'negative', label: 'Negative (invalid input, auth)' },
  { key: 'edge', label: 'Edge (boundaries, pagination)' },
  { key: 'security', label: 'Security (IDOR, injection, auth)' }
];

const AUTH_MODES: Array<{ key: RuntimeAuthMode; label: string }> = [
  { key: 'none', label: 'None' },
  { key: 'bearer', label: 'Bearer / OAuth2 token' },
  { key: 'apiKey', label: 'API key header' },
  { key: 'cookieSession', label: 'Cookie session' },
  { key: 'oauth2', label: 'OAuth2' }
];

// Booting the extension's own repo is the classic misconfiguration (it's a build, not a service).
const looksLikeExtensionRepo = (path: string): boolean => /(^|[\\/])apitiser[\\/]?$/i.test(path.trim());

const STEP_TITLES = ['Welcome', 'AI provider', 'Generation', 'Repository', 'Live validation', 'Local runs', 'All set'];
const STEP = { welcome: 0, provider: 1, generation: 2, repository: 3, validation: 4, localRuns: 5, done: 6 };

export function Onboarding() {
  const [step, setStep] = useState<number>(0);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // AI provider
  const [provider, setProvider] = useState<LLMProvider>('openai');
  const [apiKey, setApiKey] = useState<string>('');
  const [keyTest, setKeyTest] = useState<KeyTest>({ state: 'idle' });

  // Repo tokens
  const [githubToken, setGithubToken] = useState<string>('');
  const [gitlabToken, setGitlabToken] = useState<string>('');
  const [repoTest, setRepoTest] = useState<Record<HostPlatform, KeyTest>>({
    github: { state: 'idle' },
    gitlab: { state: 'idle' }
  });

  // Local runner
  const [runnerBusy, setRunnerBusy] = useState<'idle' | 'downloading' | 'checking'>('idle');
  const [runnerStatus, setRunnerStatus] = useState<LocalRunnerStatus | null>(null);
  const [copied, setCopied] = useState<string>('');

  // Free-text / numeric fields are edited locally then committed (on blur) to avoid a save per keystroke.
  const [form, setForm] = useState<Record<string, string>>({});
  const seeded = useRef(false);

  const extensionId = typeof chrome !== 'undefined' ? (chrome.runtime?.id ?? '') : '';
  const unixInstallCmd = `./install.sh ${extensionId}`;
  const winInstallCmd = `powershell -ExecutionPolicy Bypass -File .\\install.ps1 ${extensionId}`;

  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('');
    }
  };

  useEffect(() => {
    void (async () => {
      const snapshot = await sendCommand<EventMessage>({ type: 'GET_STATE' });
      if (snapshot.type === 'STATE_SNAPSHOT') {
        setSettings(snapshot.payload.settings);
        setProvider(snapshot.payload.settings.provider);
      }
    })();
  }, []);

  // Seed the free-text form once from loaded settings (later patches update `settings`, not `form`).
  useEffect(() => {
    if (!settings || seeded.current) return;
    seeded.current = true;
    setForm({
      openAiBaseUrl: settings.openAiBaseUrl ?? '',
      baseUrl: settings.baseUrl ?? '',
      testDirectories: settings.testDirectories.join(', '),
      customPromptInstructions: settings.customPromptInstructions ?? '',
      batchSize: String(settings.batchSize ?? 6),
      timeoutSec: String(Math.round((settings.timeoutMs ?? 300_000) / 1000)),
      localRepoPath: settings.localRepoPath ?? '',
      localRunPort: settings.localRunPort ? String(settings.localRunPort) : '',
      bootTimeoutMs: String(settings.localRunBootTimeoutMs ?? 180_000),
      localRunCmd: settings.localRunCmd ?? '',
      localRunStack: settings.localRunStack ?? '',
      localTestCommand: settings.localTestCommand ?? ''
    });
  }, [settings]);

  const providerConfigured = useMemo(() => {
    if (!settings) return false;
    return isProviderConfigured(settings);
  }, [settings]);

  // Derived from SAVED settings (URL fields commit on blur) so typing never flips the form mid-edit.
  const providerChoice = providerChoiceOf({ provider, openAiBaseUrl: settings?.openAiBaseUrl });
  const localChoice = localPresetFor(providerChoice);
  const discovered = settings?.availableModels?.[providerChoice] ?? [];
  const localModels = localChoice ? discovered : [];
  const listed = localChoice || discovered.length ? discovered : PROVIDER_MODELS[provider];
  // Keep the saved model selectable even if the list doesn't contain it.
  const modelOptions = settings?.model && !listed.includes(settings.model) ? [settings.model, ...listed] : listed;

  const reasoningModel = useMemo(() => Boolean(settings && isReasoningModel(settings.provider, settings.model)), [settings]);

  const patch = async (next: Partial<ExtensionSettings>): Promise<void> => {
    setSaving(true);
    try {
      const response = await sendCommand<EventMessage>({ type: 'SAVE_SETTINGS', payload: next });
      if (response.type === 'SETTINGS_SAVED') setSettings(response.payload.settings);
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const handleTestAndSaveKey = async (): Promise<void> => {
    const localBase = provider === 'openai' && isLoopbackUrl(form.openAiBaseUrl?.trim() ?? '') ? form.openAiBaseUrl!.trim() : '';
    // A local server never gets the (hidden) API key field's value.
    const trimmed = localBase ? '' : apiKey.trim();
    if (!trimmed && !localBase) {
      setKeyTest({ state: 'fail', message: 'Enter an API key first (or pick a local model below).' });
      return;
    }
    setKeyTest({ state: 'testing' });
    const response = await sendCommand<EventMessage>({
      type: 'TEST_PROVIDER_KEY',
      payload: { provider, apiKey: trimmed, baseUrl: provider === 'openai' ? form.openAiBaseUrl?.trim() || undefined : undefined }
    });
    const result = response.type === 'PROVIDER_KEY_STATUS' ? response.payload : { ok: false, message: 'Key test failed.' };
    if (result.ok) {
      const models = result.models ?? [];
      const preferredModel = localBase
        ? settings?.model ?? localChoice?.model
        : undefined;
      await patch({
        provider,
        // Prefer a model this key/server actually has; fall back to our defaults when unlisted.
        model: pickModel(models, preferredModel, PROVIDER_MODELS[provider]) ?? PROVIDER_MODELS[provider][0],
        ...(models.length ? { availableModels: { ...settings?.availableModels, [providerChoice]: models } } : {}),
        ...(trimmed ? { [PROVIDER_KEY_FIELD[provider]]: trimmed } : {}),
        ...(provider === 'openai' && form.openAiBaseUrl?.trim() ? { openAiBaseUrl: form.openAiBaseUrl.trim() } : {})
      } as Partial<ExtensionSettings>);
      setKeyTest({ state: 'ok', message: result.message });
      setApiKey('');
    } else {
      setKeyTest({ state: 'fail', message: result.message });
    }
  };

  const toggleCategory = async (category: TestCategory): Promise<void> => {
    if (!settings) return;
    const current = new Set(settings.includeCategories);
    if (current.has(category)) current.delete(category);
    else current.add(category);
    const nextList = [...current];
    await patch({ includeCategories: nextList.length ? nextList : ['positive'] });
  };

  const handleSaveRepoTokens = async (): Promise<void> => {
    const next: Partial<ExtensionSettings> = {};
    if (githubToken.trim()) next.githubToken = githubToken.trim();
    if (gitlabToken.trim()) next.gitlabToken = gitlabToken.trim();
    if (Object.keys(next).length) await patch(next);
  };

  const handleTestRepoToken = async (platform: HostPlatform): Promise<void> => {
    const token = (platform === 'github' ? githubToken : gitlabToken).trim();
    if (!token) {
      setRepoTest((s) => ({ ...s, [platform]: { state: 'fail', message: 'Enter a token first.' } }));
      return;
    }
    setRepoTest((s) => ({ ...s, [platform]: { state: 'testing' } }));
    const response = await sendCommand<EventMessage>({
      type: 'TEST_REPO_TOKEN',
      payload: { platform, token, baseUrl: platform === 'gitlab' ? settings?.gitlabBaseUrl : undefined }
    });
    const result = response.type === 'REPO_TOKEN_STATUS' ? response.payload : { ok: false, message: 'Token test failed.' };
    if (result.ok) {
      await patch(platform === 'github' ? { githubToken: token } : { gitlabToken: token });
    }
    setRepoTest((s) => ({ ...s, [platform]: { state: result.ok ? 'ok' : 'fail', message: result.message } }));
  };

  const handleDownloadRunner = async (): Promise<void> => {
    setRunnerBusy('downloading');
    try {
      await sendCommand<EventMessage>({ type: 'DOWNLOAD_RUNNER' });
    } finally {
      setRunnerBusy('idle');
    }
  };

  const handleCheckRunner = async (): Promise<void> => {
    setRunnerBusy('checking');
    try {
      const response = await sendCommand<EventMessage>({ type: 'CHECK_LOCAL_RUNNER' });
      setRunnerStatus(response.type === 'LOCAL_RUNNER_STATUS' ? response.payload : { hostOk: false, serviceOk: false, hostMessage: 'Check failed.' });
    } finally {
      setRunnerBusy('idle');
    }
  };

  const finish = async (): Promise<void> => {
    await patch({ onboardingCompletedAt: Date.now() });
    window.close();
  };

  const next = () => setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const categorySet = new Set(settings?.includeCategories ?? []);
  const repoPathWarn = looksLikeExtensionRepo(form.localRepoPath ?? '');

  return (
    <main className="onboarding">
      <header className="onboarding-head">
        <p className="eyebrow">APItiser</p>
        <ol className="onboarding-progress" aria-label="Onboarding steps">
          {STEP_TITLES.map((title, index) => (
            <li key={title} className={index === step ? 'active' : index < step ? 'done' : 'todo'}>
              <span className="dot">{index < step ? '✓' : index + 1}</span>
              <span className="step-label">{title}</span>
            </li>
          ))}
        </ol>
      </header>

      <section className="onboarding-body">
        {step === STEP.welcome ? (
          <div className="onboarding-step">
            <h1>Welcome to APItiser</h1>
            <p>
              APItiser turns a GitHub or GitLab repository into a runnable API test suite. It detects your
              endpoints, generates tests with an LLM, validates them against a live API, and hands you a
              downloadable package.
            </p>
            <p>This wizard walks you through every setting. Only the AI provider key is required — the rest have sensible defaults you can tune now or later in Settings.</p>
            <ul className="onboarding-list">
              <li><strong>AI provider</strong> — your key + model (required).</li>
              <li><strong>Generation</strong> — framework, test categories, batching.</li>
              <li><strong>Repository</strong> — tokens for private repos (optional).</li>
              <li><strong>Live validation</strong> — run &amp; auto-repair against a base URL (optional).</li>
              <li><strong>Local runs</strong> — boot your repo automatically (optional).</li>
            </ul>
          </div>
        ) : null}

        {step === STEP.provider ? (
          <div className="onboarding-step">
            <h1>AI provider &amp; model</h1>
            <p>APItiser uses your own API key. It is stored locally in this browser profile and only sent to the provider you choose.</p>
            <label className="field">
              <span>Provider</span>
              <select
                value={providerChoice}
                onChange={(e) => {
                  const next = settingsForChoice(e.target.value as ProviderChoice);
                  setProvider(next.provider ?? 'openai');
                  if (next.openAiBaseUrl) setField('openAiBaseUrl', next.openAiBaseUrl);
                  setKeyTest({ state: 'idle' });
                  void patch(next);
                }}
              >
                {PROVIDER_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              {localChoice && !localModels.length ? (
                <input
                  type="text"
                  placeholder="Model name your server has loaded"
                  value={settings?.model ?? ''}
                  onChange={(e) => void patch({ model: e.target.value })}
                />
              ) : (
                <select value={settings?.model ?? modelOptions[0]} onChange={(e) => void patch({ model: e.target.value })}>
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              )}
            </label>
            {localChoice ? (
              <label className="field">
                <span>Server URL</span>
                <input type="text" placeholder={localChoice.baseUrl} value={form.openAiBaseUrl ?? ''} onChange={(e) => setField('openAiBaseUrl', e.target.value)} onBlur={() => void patch({ openAiBaseUrl: (form.openAiBaseUrl ?? '').trim() || localChoice.baseUrl })} />
                <span className="subtle">Runs on your machine — no API key needed. Setup: <code>{localChoice.hint}</code></span>
              </label>
            ) : (
              <>
                <label className="field">
                  <span>API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={provider === 'claude' ? 'sk-ant-…' : provider === 'gemini' ? 'AIza…' : 'sk-…'}
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setKeyTest({ state: 'idle' }); }}
                  />
                </label>
                {provider === 'openai' ? (
                  <label className="field">
                    <span>Base URL <span className="subtle">(optional — for a gateway or proxy)</span></span>
                    <input type="text" placeholder="https://api.openai.com" value={form.openAiBaseUrl ?? ''} onChange={(e) => setField('openAiBaseUrl', e.target.value)} onBlur={() => void patch({ openAiBaseUrl: (form.openAiBaseUrl ?? '').trim() || 'https://api.openai.com' })} />
                  </label>
                ) : null}
              </>
            )}
            <div className="onboarding-actions-inline">
              <button type="button" className="primary" onClick={() => void handleTestAndSaveKey()} disabled={keyTest.state === 'testing'}>
                {keyTest.state === 'testing' ? 'Testing…' : localChoice ? 'Test connection & save' : 'Test & save key'}
              </button>
              {keyTest.message ? (
                <span className={`key-status ${keyTest.state}`}>{keyTest.state === 'ok' ? '✓ ' : keyTest.state === 'fail' ? '✕ ' : ''}{keyTest.message}</span>
              ) : null}
            </div>
            <label className="field">
              <span>Temperature {reasoningModel ? <span className="subtle">(ignored — this model reasons internally)</span> : null}</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                disabled={reasoningModel}
                value={reasoningModel ? '' : String(settings?.temperature ?? 0.2)}
                placeholder={reasoningModel ? 'n/a' : '0.2'}
                onChange={(e) => void patch({ temperature: Number(e.target.value) })}
              />
            </label>
            <label className="settings-checkbox onboarding-inline-check">
              <input type="checkbox" checked={Boolean(settings?.enableProviderFallback)} onChange={(e) => void patch({ enableProviderFallback: e.target.checked })} />
              <span>Auto-fallback to another configured provider on failure</span>
            </label>
            {providerConfigured ? <p className="onboarding-ok">✓ A provider key is configured.</p> : <p className="subtle">A working key is required before you can generate tests.</p>}
          </div>
        ) : null}

        {step === STEP.generation ? (
          <div className="onboarding-step">
            <h1>Generation</h1>
            <p>How APItiser writes your tests. Defaults work well for most repos.</p>
            <label className="field">
              <span>Test framework</span>
              <select value={settings?.framework ?? 'jest'} onChange={(e) => void patch({ framework: e.target.value as TestFramework })}>
                {(Object.keys(FRAMEWORK_LABELS) as TestFramework[]).map((f) => (
                  <option key={f} value={f}>{FRAMEWORK_LABELS[f]}</option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Test categories</span>
              <div className="onboarding-check-grid">
                {CATEGORIES.map((c) => (
                  <label key={c.key} className="settings-checkbox">
                    <input type="checkbox" checked={categorySet.has(c.key)} onChange={() => void toggleCategory(c.key)} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="onboarding-two-col">
              <label className="field">
                <span>Batch size</span>
                <input type="number" min={1} max={50} value={form.batchSize ?? '6'} onChange={(e) => setField('batchSize', e.target.value)} onBlur={() => void patch({ batchSize: Math.max(1, Math.min(50, Number(form.batchSize) || 6)) })} />
              </label>
              <label className="field">
                <span>Timeout per batch (seconds)</span>
                <input type="number" min={30} value={form.timeoutSec ?? '300'} onChange={(e) => setField('timeoutSec', e.target.value)} onBlur={() => void patch({ timeoutMs: Math.max(30, Number(form.timeoutSec) || 300) * 1000 })} />
              </label>
            </div>
            <label className="field">
              <span>Existing-test folders <span className="subtle">(comma-separated)</span></span>
              <input type="text" value={form.testDirectories ?? ''} onChange={(e) => setField('testDirectories', e.target.value)} onBlur={() => void patch({ testDirectories: (form.testDirectories ?? '').split(',').map((v) => v.trim()).filter(Boolean) })} />
            </label>
            <label className="settings-checkbox onboarding-inline-check">
              <input type="checkbox" checked={settings?.skipExistingTests ?? true} onChange={(e) => void patch({ skipExistingTests: e.target.checked })} />
              <span>Skip endpoints that already have tests</span>
            </label>
            <label className="field">
              <span>Custom prompt instructions <span className="subtle">(optional)</span></span>
              <textarea rows={3} placeholder="e.g. Always test pagination with limit=0. Use auth header X-Custom-Auth." value={form.customPromptInstructions ?? ''} onChange={(e) => setField('customPromptInstructions', e.target.value)} onBlur={() => void patch({ customPromptInstructions: (form.customPromptInstructions ?? '').trim() })} />
            </label>
          </div>
        ) : null}

        {step === STEP.repository ? (
          <div className="onboarding-step">
            <h1>Repository access <span className="subtle">(optional)</span></h1>
            <p>Public repositories work with no token. To scan <strong>private</strong> repositories, add a token with read access to repository contents.</p>
            <label className="field">
              <span>GitHub token <span className="subtle">(fine-grained or classic, <code>repo</code> / contents:read)</span></span>
              <input type="password" autoComplete="off" placeholder="ghp_… / github_pat_…" value={githubToken} onChange={(e) => { setGithubToken(e.target.value); setRepoTest((s) => ({ ...s, github: { state: 'idle' } })); }} />
            </label>
            <div className="onboarding-actions-inline">
              <button type="button" className="ghost" onClick={() => void handleTestRepoToken('github')} disabled={repoTest.github.state === 'testing' || saving}>
                {repoTest.github.state === 'testing' ? 'Testing…' : 'Test GitHub token'}
              </button>
              {repoTest.github.message ? (
                <span className={`key-status ${repoTest.github.state}`}>{repoTest.github.state === 'ok' ? '✓ ' : repoTest.github.state === 'fail' ? '✕ ' : ''}{repoTest.github.message}</span>
              ) : null}
            </div>
            <label className="field">
              <span>GitLab token <span className="subtle">(<code>read_api</code> / <code>read_repository</code>)</span></span>
              <input type="password" autoComplete="off" placeholder="glpat-…" value={gitlabToken} onChange={(e) => { setGitlabToken(e.target.value); setRepoTest((s) => ({ ...s, gitlab: { state: 'idle' } })); }} />
            </label>
            <div className="onboarding-actions-inline">
              <button type="button" className="ghost" onClick={() => void handleTestRepoToken('gitlab')} disabled={repoTest.gitlab.state === 'testing' || saving}>
                {repoTest.gitlab.state === 'testing' ? 'Testing…' : 'Test GitLab token'}
              </button>
              {repoTest.gitlab.message ? (
                <span className={`key-status ${repoTest.gitlab.state}`}>{repoTest.gitlab.state === 'ok' ? '✓ ' : repoTest.gitlab.state === 'fail' ? '✕ ' : ''}{repoTest.gitlab.message}</span>
              ) : null}
            </div>
            <label className="field">
              <span>GitLab base URL <span className="subtle">(self-hosted)</span></span>
              <input type="text" placeholder="https://gitlab.com" value={settings?.gitlabBaseUrl ?? 'https://gitlab.com'} onChange={(e) => void patch({ gitlabBaseUrl: e.target.value })} />
            </label>
          </div>
        ) : null}

        {step === STEP.validation ? (
          <div className="onboarding-step">
            <h1>Live validation <span className="subtle">(optional)</span></h1>
            <p>APItiser can execute the generated suite against a running instance before packaging, then auto-repair failures. The Base URL is also injected into downloaded test files — worth setting even if you don't validate here.</p>
            <label className="field">
              <span>Base URL</span>
              <input type="text" placeholder="http://localhost:3000" value={form.baseUrl ?? ''} onChange={(e) => setField('baseUrl', e.target.value)} onBlur={() => void patch({ baseUrl: (form.baseUrl ?? '').trim() })} />
            </label>
            <label className="settings-checkbox onboarding-inline-check">
              <input type="checkbox" checked={settings?.validateGeneratedTests ?? true} onChange={(e) => void patch({ validateGeneratedTests: e.target.checked })} />
              <span>Validate generated tests against the Base URL</span>
            </label>
            <label className="settings-checkbox onboarding-inline-check">
              <input type="checkbox" checked={settings?.autoRepairFailingTests ?? true} onChange={(e) => void patch({ autoRepairFailingTests: e.target.checked })} />
              <span>Auto-repair tests that fail live validation</span>
            </label>
            <div className="onboarding-two-col">
              <label className="field">
                <span>Auth mode</span>
                <select value={settings?.runtimeAuthMode ?? 'none'} onChange={(e) => void patch({ runtimeAuthMode: e.target.value as RuntimeAuthMode })}>
                  {AUTH_MODES.map((a) => (
                    <option key={a.key} value={a.key}>{a.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Max repair rounds</span>
                <input type="number" min={0} max={5} value={String(settings?.maxValidationRepairs ?? 2)} onChange={(e) => void patch({ maxValidationRepairs: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })} />
              </label>
            </div>
            <label className="settings-checkbox onboarding-inline-check">
              <input type="checkbox" checked={settings?.retryOnRateLimit ?? true} onChange={(e) => void patch({ retryOnRateLimit: e.target.checked })} />
              <span>Retry transient 429 / 5xx responses during validation</span>
            </label>
            <p className="subtle">Auth <em>credentials</em> and setup/login flows are secrets — configure them in <strong>Settings → Live validation</strong>.</p>
          </div>
        ) : null}

        {step === STEP.localRuns ? (
          <div className="onboarding-step">
            <h1>Local runs <span className="subtle">(optional)</span></h1>
            <p>APItiser can boot your repository locally and validate the generated suite against it automatically — no need to start the service by hand. This needs a one-time native-messaging host install.</p>

            <div className="onboarding-note">
              <strong>Before you start — requirements</strong>
              <ul className="onboarding-list">
                <li><strong>Node.js</strong> on your PATH (the host runs on Node). Python/Go also needed if your repo uses them.</li>
                <li>The target repo must be a <strong>bootable API service</strong> with a start/dev command (e.g. <code>npm run dev</code>, <code>uvicorn</code>, <code>go run</code>) — or a <code>docker-compose.yml</code>.</li>
                <li>The repo must be <strong>cloned locally</strong>; you'll point APItiser at its absolute path below.</li>
              </ul>
            </div>

            <ol className="onboarding-list numbered">
              <li>
                <strong>Download the runner</strong> — a small ZIP with the native-messaging host.
                <div className="onboarding-actions-inline">
                  <button type="button" className="ghost" onClick={() => void handleDownloadRunner()} disabled={runnerBusy !== 'idle'}>
                    {runnerBusy === 'downloading' ? 'Preparing…' : '⬇ Download runner'}
                  </button>
                </div>
              </li>
              <li>
                <strong>Install it</strong> — unzip, then run the installer for your OS <em>from the unzipped folder</em>. The installer locks the host to this extension, so pass the ID below. One-time step.
                <div className="copy-field">
                  <span className="copy-label">Your extension ID</span>
                  <div className="copy-row">
                    <code>{extensionId || 'unavailable — open this page from the extension'}</code>
                    <button type="button" className="ghost copy-btn" onClick={() => void copy('id', extensionId)} disabled={!extensionId}>{copied === 'id' ? 'Copied ✓' : 'Copy'}</button>
                  </div>
                </div>
                <div className="copy-field">
                  <span className="copy-label">macOS / Linux</span>
                  <div className="copy-row">
                    <code>{unixInstallCmd}</code>
                    <button type="button" className="ghost copy-btn" onClick={() => void copy('unix', unixInstallCmd)} disabled={!extensionId}>{copied === 'unix' ? 'Copied ✓' : 'Copy'}</button>
                  </div>
                </div>
                <div className="copy-field">
                  <span className="copy-label">Windows (PowerShell)</span>
                  <div className="copy-row">
                    <code>{winInstallCmd}</code>
                    <button type="button" className="ghost copy-btn" onClick={() => void copy('win', winInstallCmd)} disabled={!extensionId}>{copied === 'win' ? 'Copied ✓' : 'Copy'}</button>
                  </div>
                </div>
              </li>
              <li>
                <strong>Configure &amp; verify</strong>
                <label className="settings-checkbox onboarding-inline-check">
                  <input type="checkbox" checked={Boolean(settings?.enableLocalRunner)} onChange={(e) => void patch({ enableLocalRunner: e.target.checked })} disabled={saving} />
                  <span>Enable local runs</span>
                </label>
                <label className="field">
                  <span>Local repo path <span className="subtle">(absolute path to the API service to boot)</span></span>
                  <input type="text" placeholder="/Users/you/code/my-api" value={form.localRepoPath ?? ''} onChange={(e) => setField('localRepoPath', e.target.value)} onBlur={() => void patch({ localRepoPath: (form.localRepoPath ?? '').trim() })} />
                </label>
                {repoPathWarn ? (
                  <p className="onboarding-warn">⚠ This looks like the APItiser extension's own repo. Point this at a <strong>bootable API service</strong> (one with a start/dev command) — the extension itself isn't a server and the boot will fail.</p>
                ) : null}
                <div className="onboarding-two-col">
                  <label className="field">
                    <span>Local run port</span>
                    <input type="number" min={0} max={65535} placeholder="Auto (free port)" value={form.localRunPort ?? ''} onChange={(e) => setField('localRunPort', e.target.value)} onBlur={() => void patch({ localRunPort: Number(form.localRunPort) || 0 })} />
                  </label>
                  <label className="field">
                    <span>Boot timeout (ms)</span>
                    <input type="number" min={10000} value={form.bootTimeoutMs ?? '180000'} onChange={(e) => setField('bootTimeoutMs', e.target.value)} onBlur={() => void patch({ localRunBootTimeoutMs: Number(form.bootTimeoutMs) || 180_000 })} />
                  </label>
                </div>
                <label className="field">
                  <span>Run command override <span className="subtle">(optional — auto-detected if blank)</span></span>
                  <input type="text" placeholder="e.g. npm run start:dev" value={form.localRunCmd ?? ''} onChange={(e) => setField('localRunCmd', e.target.value)} onBlur={() => void patch({ localRunCmd: (form.localRunCmd ?? '').trim() })} />
                </label>
                <div className="onboarding-two-col">
                  <label className="field">
                    <span>Stack override <span className="subtle">(optional)</span></span>
                    <input type="text" placeholder="node | python | go" value={form.localRunStack ?? ''} onChange={(e) => setField('localRunStack', e.target.value)} onBlur={() => void patch({ localRunStack: (form.localRunStack ?? '').trim() })} />
                  </label>
                  <label className="field">
                    <span>Test command override <span className="subtle">(optional)</span></span>
                    <input type="text" placeholder="auto-detected" value={form.localTestCommand ?? ''} onChange={(e) => setField('localTestCommand', e.target.value)} onBlur={() => void patch({ localTestCommand: (form.localTestCommand ?? '').trim() })} />
                  </label>
                </div>
                <div className="onboarding-actions-inline">
                  <button type="button" className="ghost" onClick={() => void handleCheckRunner()} disabled={runnerBusy !== 'idle'}>
                    {runnerBusy === 'checking' ? 'Checking…' : 'Check installation'}
                  </button>
                  {runnerStatus ? (
                    <span className={`key-status ${runnerStatus.hostOk ? 'ok' : 'fail'}`}>
                      {runnerStatus.hostOk ? '✓ ' : '✕ '}
                      {runnerStatus.hostOk ? 'Host reachable' : (runnerStatus.hostMessage || 'Host not found — is it installed?')}
                    </span>
                  ) : null}
                </div>
              </li>
            </ol>

            <div className="onboarding-note">
              <strong>What happens when you use it</strong>
              <ul className="onboarding-list">
                <li><strong>Run Locally</strong> (in the side panel, after generating) asks the host to install deps and boot your repo on the port above via <code>runLocal</code>, then runs the generated suite against <code>http://localhost:&lt;port&gt;</code> and applies the results.</li>
                <li><strong>Run Repo Tests</strong> installs deps and runs the repo's own test command (auto-detected, or your override).</li>
                <li>Leave a field blank to auto-detect — port, stack, and commands are all inferred from the repo when possible.</li>
              </ul>
            </div>

            <div className="onboarding-note">
              <strong>Troubleshooting</strong>
              <ul className="onboarding-list">
                <li><strong>"Host not found"</strong> → the installer hasn't run, or was run with the wrong extension ID. Re-run <code>install.sh</code> / <code>install.ps1</code> with the ID above, then restart Chrome.</li>
                <li><strong>Boot fails with a build error</strong> → confirm the repo starts on its own from a terminal, and that Node/Python/Go for its stack are installed.</li>
                <li><strong>macOS "esbuild can't be opened"</strong> → Gatekeeper quarantine. The runner now strips it automatically; if it recurs, run <code>xattr -dr com.apple.quarantine &lt;repo-path&gt;</code> once.</li>
                <li><strong>Port already in use</strong> → change the Local run port above to a free port.</li>
              </ul>
            </div>

            <p className="subtle">Optional — you can skip this and still validate against any Base URL. Everything here is also in <strong>Settings → Local runner</strong>.</p>
          </div>
        ) : null}

        {step === STEP.done ? (
          <div className="onboarding-step">
            <h1>You're all set 🎉</h1>
            <p>Here's how to generate your first suite:</p>
            <ol className="onboarding-list numbered">
              <li>Open a GitHub or GitLab repository page in a browser tab.</li>
              <li>Click the <strong>APItiser</strong> toolbar icon to open the side panel.</li>
              <li>Press <strong>Scan</strong>, pick the endpoints you want, then <strong>Generate</strong>.</li>
              <li>Preview, validate, and download your test package.</li>
            </ol>
            {!providerConfigured ? (
              <p className="onboarding-warn">⚠ No AI provider key is configured yet. Add one in Settings — generation won't run without it.</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <footer className="onboarding-foot">
        <button type="button" className="ghost" onClick={back} disabled={step === 0}>Back</button>
        <div className="foot-right">
          {step < STEP_TITLES.length - 1 ? (
            <>
              <button type="button" className="link-btn" onClick={() => void finish()}>Skip setup</button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  if (step === STEP.repository) await handleSaveRepoTokens();
                  next();
                }}
                disabled={saving}
              >
                {step === STEP.welcome ? 'Get started' : 'Continue'}
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={() => void finish()} disabled={saving}>Finish</button>
          )}
        </div>
      </footer>
    </main>
  );
}
