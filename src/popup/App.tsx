import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDER_MODELS } from '@shared/constants';
import type { AppState, JobStage, RepoRef, TestCategory } from '@shared/types';
import type { EventMessage } from '@shared/messages';
import { sendCommand } from './runtime';
import { parseRepoFromUrl } from '@shared/repo';

const stageOrder: JobStage[] = ['scanning', 'parsing', 'generating', 'packaging', 'complete'];

const isActiveStage = (stage: JobStage | undefined, check: JobStage): 'done' | 'active' | 'todo' => {
  if (!stage || stage === 'idle') {
    return 'todo';
  }

  const currentIndex = stageOrder.indexOf(stage);
  const checkIndex = stageOrder.indexOf(check);

  if (stage === 'error' || stage === 'cancelled') {
    return check === 'complete' ? 'todo' : 'done';
  }

  if (currentIndex > checkIndex) {
    return 'done';
  }

  if (currentIndex === checkIndex) {
    return 'active';
  }

  return 'todo';
};

const displayPlatform = (repo: RepoRef | null): string => {
  if (!repo) {
    return 'No repository detected';
  }
  return `${repo.platform.toUpperCase()} • ${repo.owner}/${repo.repo}`;
};

const formatMs = (value?: number): string => {
  if (!value && value !== 0) {
    return '—';
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
};

const normalizeUrlForContext = (url?: string): string => {
  if (!url) {
    return 'blank';
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('#')[0].split('?')[0];
  }
};

const deriveContextIdFromTab = (tab?: chrome.tabs.Tab): string => {
  const tabId = tab?.id ?? -1;
  const page = normalizeUrlForContext(tab?.url);
  return `tab:${tabId}|page:${page}`;
};

export function App() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [repo, setRepo] = useState<RepoRef | null>(null);
  const [notice, setNotice] = useState<string>('Connecting to APItiser worker...');
  const [error, setError] = useState<string>('');
  const [testDirsInput, setTestDirsInput] = useState<string>('tests, __tests__, test');
  const [openApiFallbackInput, setOpenApiFallbackInput] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [contextId, setContextId] = useState<string>('global');
  const [selectedEndpointIds, setSelectedEndpointIds] = useState<string[]>([]);
  const contextRef = useRef<string>('global');
  const endpointSelectionSeedRef = useRef<string>('');

  const activeOrLatestJob = useMemo(() => {
    if (!appState) {
      return null;
    }
    return appState.activeJob ?? appState.jobHistory[0] ?? null;
  }, [appState]);

  const selectedProvider = appState?.settings.provider ?? 'openai';
  const skipExistingEnabled = appState?.settings.skipExistingTests ?? true;
  const availableModels = PROVIDER_MODELS[selectedProvider];
  const latestMetric = appState?.metricsHistory?.[0];
  const endpoints = activeOrLatestJob?.endpoints ?? [];
  const endpointIds = useMemo(() => endpoints.map((endpoint) => endpoint.id), [endpoints]);
  const endpointSignature = useMemo(() => endpointIds.join('|'), [endpointIds]);
  const selectedEndpointSet = useMemo(() => new Set(selectedEndpointIds), [selectedEndpointIds]);
  const selectedEndpointCount = useMemo(
    () => endpointIds.filter((endpointId) => selectedEndpointSet.has(endpointId)).length,
    [endpointIds, selectedEndpointSet]
  );
  const existingCoveredSet = useMemo(
    () => new Set(activeOrLatestJob?.existingTestEndpointIds ?? []),
    [activeOrLatestJob?.existingTestEndpointIds]
  );
  const selectedEligibleCount = useMemo(() => {
    if (!skipExistingEnabled) {
      return selectedEndpointCount;
    }
    return endpoints.filter((endpoint) => selectedEndpointSet.has(endpoint.id) && !existingCoveredSet.has(endpoint.id)).length;
  }, [skipExistingEnabled, endpoints, existingCoveredSet, selectedEndpointCount, selectedEndpointSet]);

  const resolveActiveTab = async (gitlabBaseUrl?: string) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const nextContextId = deriveContextIdFromTab(tab);
    contextRef.current = nextContextId;
    setContextId(nextContextId);

    if (!tab?.url) {
      setRepo(null);
      return nextContextId;
    }

    const detected = parseRepoFromUrl(tab.url, gitlabBaseUrl || 'https://gitlab.com');
    setRepo(detected);
    return nextContextId;
  };

  const loadInitial = async (nextContextId: string) => {
    const snapshot = await sendCommand<EventMessage>({ type: 'GET_STATE', contextId: nextContextId });
    if (snapshot.type === 'STATE_SNAPSHOT') {
      setAppState(snapshot.payload);
      setNotice('Ready');
      setError('');
    }
  };

  useEffect(() => {
    void (async () => {
      const nextContextId = await resolveActiveTab(appState?.settings.gitlabBaseUrl);
      await loadInitial(nextContextId);
    })();

    const listener = (message: EventMessage) => {
      if (
        'contextId' in message &&
        message.contextId &&
        message.contextId !== contextRef.current
      ) {
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
      }
    };

    const refreshFromCurrentTab = async () => {
      const nextContextId = await resolveActiveTab(appState?.settings.gitlabBaseUrl);
      const snapshot = await sendCommand<EventMessage>({ type: 'GET_STATE', contextId: nextContextId });
      if (snapshot.type === 'STATE_SNAPSHOT' && nextContextId === contextRef.current) {
        setAppState(snapshot.payload);
      }
    };

    const handleActivated = () => {
      void refreshFromCurrentTab();
    };

    const handleUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.status === 'complete') {
        void refreshFromCurrentTab();
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [appState?.settings.gitlabBaseUrl]);

  useEffect(() => {
    if (!appState) {
      return;
    }
    setTestDirsInput(appState.settings.testDirectories.join(', '));
  }, [appState?.settings.testDirectories]);

  useEffect(() => {
    if (!appState) {
      return;
    }
    setOpenApiFallbackInput(appState.settings.openApiFallbackSpec ?? '');
  }, [appState?.settings.openApiFallbackSpec]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [settingsOpen]);

  useEffect(() => {
    if (!endpointIds.length) {
      endpointSelectionSeedRef.current = '';
      setSelectedEndpointIds([]);
      return;
    }

    const seed = `${contextId}|${activeOrLatestJob?.jobId ?? 'none'}|${endpointSignature}`;
    if (endpointSelectionSeedRef.current !== seed) {
      endpointSelectionSeedRef.current = seed;
      setSelectedEndpointIds(endpointIds);
      return;
    }

    const validEndpointIds = new Set(endpointIds);
    setSelectedEndpointIds((current) => {
      const valid = current.filter((endpointId) => validEndpointIds.has(endpointId));
      return valid.length === current.length ? current : valid;
    });
  }, [activeOrLatestJob?.jobId, contextId, endpointIds, endpointSignature]);

  useEffect(() => {
    if (!skipExistingEnabled || !existingCoveredSet.size) {
      return;
    }
    setSelectedEndpointIds((current) => {
      const filtered = current.filter((endpointId) => !existingCoveredSet.has(endpointId));
      return filtered.length === current.length ? current : filtered;
    });
  }, [skipExistingEnabled, existingCoveredSet]);

  const patchSettings = async (patch: Partial<AppState['settings']>) => {
    setError('');
    const response = await sendCommand<EventMessage>({
      type: 'SAVE_SETTINGS',
      payload: patch,
      contextId
    });

    if (response.type === 'SETTINGS_SAVED') {
      setAppState(response.payload);
    }
  };

  const handleCategoryToggle = async (category: TestCategory) => {
    if (!appState) {
      return;
    }

    const current = new Set(appState.settings.includeCategories);
    if (current.has(category)) {
      current.delete(category);
    } else {
      current.add(category);
    }

    const next = [...current];
    await patchSettings({ includeCategories: next.length ? next : ['positive'] });
  };

  const persistTestFoldersIfChanged = async () => {
    if (!appState) {
      return;
    }

    const normalizedDirs = testDirsInput
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (normalizedDirs.join('|') !== appState.settings.testDirectories.join('|')) {
      await patchSettings({ testDirectories: normalizedDirs });
    }
  };

  const persistOpenApiFallbackIfChanged = async () => {
    if (!appState) {
      return;
    }

    const normalized = openApiFallbackInput.trim();
    const current = (appState.settings.openApiFallbackSpec ?? '').trim();
    if (normalized !== current) {
      await patchSettings({ openApiFallbackSpec: normalized });
    }
  };

  const handleValidateAccess = async () => {
    if (!repo) {
      setError('Open a GitHub or GitLab repository tab first.');
      return;
    }

    await persistTestFoldersIfChanged();
    setError('');
    setNotice('Validating repository access and token scopes...');
    const response = await sendCommand<EventMessage>({ type: 'VALIDATE_REPO_ACCESS', payload: { repo }, contextId });

    if (response.type === 'JOB_ERROR') {
      setError(response.error);
      return;
    }

    if (response.type === 'STATE_SNAPSHOT' || response.type === 'SETTINGS_SAVED' || response.type === 'JOB_PROGRESS' || response.type === 'JOB_COMPLETE') {
      setNotice(response.payload.lastValidation?.ok ? 'Validation passed' : 'Validation completed with issues');
    } else {
      setNotice('Validation completed');
    }
  };

  const handleScan = async () => {
    if (!repo) {
      setError('Open a GitHub or GitLab repository tab before scanning.');
      return;
    }

    await persistTestFoldersIfChanged();
    await persistOpenApiFallbackIfChanged();

    setError('');
    setNotice('Scanning repository...');
    const response = await sendCommand<EventMessage>({ type: 'START_SCAN', payload: { repo }, contextId });

    if (response.type === 'JOB_ERROR') {
      setError(response.error);
      return;
    }

    setNotice('Scan complete. Review endpoints and generate tests.');
  };

  const handleImportOpenApiFile = async (file: File | null | undefined) => {
    if (!file) {
      return;
    }
    const text = await file.text();
    setOpenApiFallbackInput(text);
    await patchSettings({ openApiFallbackSpec: text.trim() });
  };

  const handleGenerate = async () => {
    const selectedForGeneration = endpoints
      .filter((endpoint) => selectedEndpointSet.has(endpoint.id))
      .filter((endpoint) => !skipExistingEnabled || !existingCoveredSet.has(endpoint.id))
      .map((endpoint) => endpoint.id);

    if (!selectedForGeneration.length) {
      if (skipExistingEnabled && selectedEndpointCount > 0) {
        setError('All selected endpoints are already covered by existing tests.');
      } else {
        setError('Select at least one endpoint to generate tests.');
      }
      return;
    }

    setError('');
    setNotice('Generating tests...');
    const response = await sendCommand<EventMessage>({
      type: 'START_GENERATION',
      payload: { selectedEndpointIds: selectedForGeneration },
      contextId
    });
    if (response.type === 'JOB_ERROR') {
      setError(response.error);
      return;
    }
    setNotice('Generation complete. Download your suite.');
  };

  const handleEndpointToggle = (endpointId: string, checked: boolean) => {
    setSelectedEndpointIds((current) => {
      if (checked) {
        if (current.includes(endpointId)) {
          return current;
        }
        return [...current, endpointId];
      }
      return current.filter((value) => value !== endpointId);
    });
  };

  const handleSelectAllEndpoints = () => {
    if (!skipExistingEnabled) {
      setSelectedEndpointIds(endpointIds);
      return;
    }

    const eligibleIds = endpoints
      .filter((endpoint) => !existingCoveredSet.has(endpoint.id))
      .map((endpoint) => endpoint.id);
    setSelectedEndpointIds(eligibleIds);
  };

  const handleClearAllEndpoints = () => {
    setSelectedEndpointIds([]);
  };

  const handleClear = async () => {
    setError('');
    const response = await sendCommand<EventMessage>({ type: 'CLEAR_CONTEXT', contextId });
    if (response.type === 'JOB_ERROR') {
      setError(response.error);
      return;
    }
    if (response.type === 'STATE_SNAPSHOT') {
      setAppState(response.payload);
    }
    setNotice('Context cleared');
  };

  const handleDownload = async () => {
    const artifact = appState?.artifacts?.[0];
    if (!artifact) {
      setError('No generated artifact available for download.');
      return;
    }

    const response = await sendCommand<EventMessage>({
      type: 'DOWNLOAD_ARTIFACT',
      payload: { artifactId: artifact.id },
      contextId
    });

    if (response.type === 'JOB_ERROR') {
      setError(response.error);
      return;
    }

    setNotice('Download started');
  };

  const openExtensionDoc = async (path: 'help.html' | 'policypolicy.html') => {
    const url = chrome.runtime.getURL(path);
    await chrome.tabs.create({ url });
  };

  const busy = ['scanning', 'parsing', 'generating', 'packaging'].includes(activeOrLatestJob?.stage ?? 'idle');

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">APItiser</p>
          <h1>API Tests in Seconds</h1>
          <p className="subtle">{displayPlatform(repo)}</p>
        </div>
        <div className="hero-controls">
          <span className={`status-pill stage-${activeOrLatestJob?.stage ?? 'idle'}`}>
            {activeOrLatestJob?.statusText ?? notice}
          </span>
          <button type="button" className="ghost settings-trigger" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {error ? <section className="error-banner">{error}</section> : null}

      {settingsOpen ? (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            className="panel settings-panel modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Settings</h2>
              <button type="button" className="ghost modal-close" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="settings-group">
              <h3>Provider & Model</h3>
              <div className="grid two">
                <label>
                  Provider
                  <select
                    value={appState?.settings.provider ?? 'openai'}
                    onChange={(event) =>
                      void patchSettings({
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
                    onChange={(event) => void patchSettings({ model: event.target.value })}
                  >
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                API Key
                <input
                  type="password"
                  placeholder="Paste provider API key"
                  value={
                    selectedProvider === 'openai'
                      ? appState?.settings.openAiKey ?? ''
                      : selectedProvider === 'claude'
                        ? appState?.settings.claudeKey ?? ''
                        : appState?.settings.geminiKey ?? ''
                  }
                  onChange={(event) => {
                    if (selectedProvider === 'openai') {
                      void patchSettings({ openAiKey: event.target.value });
                    } else if (selectedProvider === 'claude') {
                      void patchSettings({ claudeKey: event.target.value });
                    } else {
                      void patchSettings({ geminiKey: event.target.value });
                    }
                  }}
                />
              </label>
            </div>

        <div className="settings-group">
          <h3>Repo Access</h3>
          <div className="grid two">
            <label>
              GitHub Token
              <input
                type="password"
                value={appState?.settings.githubToken ?? ''}
                onChange={(event) => void patchSettings({ githubToken: event.target.value })}
                placeholder="Optional for public repos"
              />
            </label>
            <label>
              GitLab Token
              <input
                type="password"
                value={appState?.settings.gitlabToken ?? ''}
                onChange={(event) => void patchSettings({ gitlabToken: event.target.value })}
                placeholder="Required for private repos"
              />
            </label>
          </div>
          <label>
            GitLab Base URL
            <input
              type="text"
              value={appState?.settings.gitlabBaseUrl ?? 'https://gitlab.com'}
              onChange={(event) => void patchSettings({ gitlabBaseUrl: event.target.value })}
              placeholder="https://gitlab.company.com"
            />
          </label>

          <button type="button" className="ghost utility-btn" onClick={handleValidateAccess} disabled={busy || !repo}>
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

        <div className="settings-group">
          <h3>Test Configuration</h3>
          <div className="grid two">
            <label>
              Framework
              <select
                value={appState?.settings.framework ?? 'jest'}
                onChange={(event) => void patchSettings({ framework: event.target.value as AppState['settings']['framework'] })}
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
                onChange={(event) => void patchSettings({ batchSize: Number(event.target.value) })}
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
              onChange={(event) => void patchSettings({ timeoutMs: Number(event.target.value) * 1000 })}
            />
          </label>
          <label>
            Test Files Folders (comma-separated)
            <input
              type="text"
              value={testDirsInput}
              onChange={(event) => setTestDirsInput(event.target.value)}
              onBlur={() => void persistTestFoldersIfChanged()}
              placeholder="tests, __tests__, api-tests"
            />
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={appState?.settings.skipExistingTests ?? true}
              onChange={(event) => void patchSettings({ skipExistingTests: event.target.checked })}
            />
            Skip endpoints that already have tests
          </label>

          <div className="category-row">
            {(['positive', 'negative', 'edge', 'security'] as const).map((category) => (
              <button
                key={category}
                type="button"
                className={`chip ${appState?.settings.includeCategories.includes(category) ? 'active' : ''}`}
                onClick={() => void handleCategoryToggle(category)}
              >
                {category}
              </button>
            ))}
          </div>
        </div>

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
              onChange={(event) => void handleImportOpenApiFile(event.target.files?.[0])}
            />
          </label>
          <label>
            OpenAPI Spec (JSON/YAML)
            <textarea
              className="spec-input"
              rows={8}
              value={openApiFallbackInput}
              onChange={(event) => setOpenApiFallbackInput(event.target.value)}
              onBlur={() => void persistOpenApiFallbackIfChanged()}
              placeholder="openapi: 3.0.0"
            />
          </label>
          <button
            type="button"
            className="ghost utility-btn"
            onClick={() => {
              setOpenApiFallbackInput('');
              void patchSettings({ openApiFallbackSpec: '' });
            }}
            disabled={!openApiFallbackInput.trim()}
          >
            Clear Fallback Spec
          </button>
        </div>

        <div className="settings-group">
          <h3>Help & Policy</h3>
          <div className="grid two">
            <button type="button" className="ghost utility-btn" onClick={() => void openExtensionDoc('help.html')}>
              Help
            </button>
            <button type="button" className="ghost utility-btn" onClick={() => void openExtensionDoc('policypolicy.html')}>
              Privacy Policy
            </button>
          </div>
        </div>
          </section>
        </div>
      ) : null}

      <section className="panel timeline">
        <h2>Progress</h2>
        <div className="steps">
          {stageOrder.map((stage) => (
            <span key={stage} className={`step ${isActiveStage(activeOrLatestJob?.stage, stage)}`}>
              {stage}
            </span>
          ))}
        </div>
        <div className="progress-wrap">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${activeOrLatestJob?.progress ?? 0}%` }} />
          </div>
          <strong>{activeOrLatestJob?.progress ?? 0}%</strong>
        </div>
        <p className="subtle">{activeOrLatestJob?.statusText ?? 'No active job'}</p>
        {activeOrLatestJob?.resumedFromCheckpoint ? (
          <p className="subtle">Recovered from checkpoint after worker restart.</p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Detected Endpoints</h2>
        <p className="subtle">{activeOrLatestJob?.totalEndpoints ?? 0} APIs found</p>
        <p className="subtle">
          {activeOrLatestJob?.existingTestEndpointIds?.length ?? 0} already tested •{' '}
          {activeOrLatestJob?.eligibleEndpointCount ?? activeOrLatestJob?.totalEndpoints ?? 0} to generate
        </p>
        {endpoints.length ? (
          <>
            <div className="endpoint-controls">
              <p className="subtle">
                {selectedEndpointCount} selected • {selectedEligibleCount} selected for generation
              </p>
              <div className="endpoint-control-actions">
                <button type="button" className="ghost endpoint-control-btn" onClick={handleSelectAllEndpoints} disabled={busy}>
                  Select All
                </button>
                <button type="button" className="ghost endpoint-control-btn" onClick={handleClearAllEndpoints} disabled={busy}>
                  Clear All
                </button>
              </div>
            </div>
            <div className="endpoint-list endpoint-list-scroll">
              {endpoints.map((endpoint) => {
                const blockedBySkip = skipExistingEnabled && existingCoveredSet.has(endpoint.id);
                const checked = selectedEndpointSet.has(endpoint.id) && !blockedBySkip;
                return (
                  <label key={endpoint.id} className={`endpoint-row ${checked ? 'checked' : 'unchecked'}`}>
                    <input
                      className="endpoint-checkbox"
                      type="checkbox"
                      checked={checked}
                      disabled={busy || blockedBySkip}
                      onChange={(event) => handleEndpointToggle(endpoint.id, event.target.checked)}
                    />
                    <code>{endpoint.method}</code>
                    <span>{endpoint.path}</span>
                    <div className="endpoint-badges">
                      {endpoint.confidence ? (
                        <em
                          className="endpoint-tag"
                          title={endpoint.evidence?.[0]?.reason ? `Evidence: ${endpoint.evidence[0].reason}` : 'Detection confidence'}
                        >
                          {Math.round(endpoint.confidence * 100)}% conf
                        </em>
                      ) : null}
                      {existingCoveredSet.has(endpoint.id) ? <em className="endpoint-tag">existing test</em> : null}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        ) : (
          <p className="subtle">No endpoints yet. Run Scan Repo to populate this list.</p>
        )}
      </section>

      <section className="panel">
        <h2>Coverage Snapshot</h2>
        <div className="coverage-grid">
          <article>
            <p>Endpoints</p>
            <strong>{activeOrLatestJob?.coverage?.endpointsDetected ?? activeOrLatestJob?.totalEndpoints ?? 0}</strong>
          </article>
          <article>
            <p>Tests</p>
            <strong>{activeOrLatestJob?.coverage?.testsGenerated ?? activeOrLatestJob?.generatedTests.length ?? 0}</strong>
          </article>
          <article>
            <p>Coverage</p>
            <strong>{activeOrLatestJob?.coverage?.coveragePercent ?? 0}%</strong>
          </article>
        </div>

        <div className="gap-list">
          {(activeOrLatestJob?.coverage?.gaps ?? []).slice(0, 3).map((gap) => (
            <p key={gap}>{gap}</p>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Performance</h2>
        <div className="coverage-grid">
          <article>
            <p>Scan Time</p>
            <strong>{formatMs(latestMetric?.scanMs)}</strong>
          </article>
          <article>
            <p>Generation Time</p>
            <strong>{formatMs(latestMetric?.generationMs)}</strong>
          </article>
          <article>
            <p>Total Runtime</p>
            <strong>{formatMs(latestMetric?.totalMs)}</strong>
          </article>
        </div>
        {latestMetric ? (
          <p className="subtle">
            Last run: {latestMetric.status.toUpperCase()} • {latestMetric.endpointsDetected} endpoints • {latestMetric.testsGenerated} tests
          </p>
        ) : (
          <p className="subtle">Run a full scan + generate cycle to capture metrics.</p>
        )}
      </section>

      <footer className="actions">
        <button type="button" onClick={handleScan} disabled={busy || !repo}>
          Scan Repo
        </button>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy || !endpoints.length || (skipExistingEnabled ? !selectedEligibleCount : !selectedEndpointCount)}
        >
          Generate Tests
        </button>
        <button type="button" onClick={handleDownload} disabled={!appState?.artifacts.length}>
          Download Tests
        </button>
        <button type="button" onClick={handleClear} className="ghost">
          Clear
        </button>
      </footer>
    </main>
  );
}
