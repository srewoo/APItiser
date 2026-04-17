import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDER_MODELS } from '@shared/constants';
import type { AppState, JobStage, RepoRef, TestCategory } from '@shared/types';
import type { EventMessage } from '@shared/messages';
import { sendCommand } from './runtime';
import { parseRepoFromUrl } from '@shared/repo';
import { usePopupState } from './hooks/usePopupState';
import { SettingsModal } from './components/SettingsModal';
import { ProgressTimeline } from './components/ProgressTimeline';
import { EndpointList } from './components/EndpointList';
import { CoveragePanel, PerformancePanel } from './components/CoveragePanel';
import { ActionFooter } from './components/ActionFooter';
import { TestPreviewModal } from './components/TestPreviewModal';
import { ErrorBoundary } from './components/ErrorBoundary';

const displayPlatform = (repo: RepoRef | null): string => {
  if (!repo) return 'No repository detected';
  return `${repo.platform.toUpperCase()} • ${repo.owner}/${repo.repo}`;
};

const normalizeUrlForContext = (url?: string): string => {
  if (!url) return 'blank';
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
  const { appState, setContextId: setPopupContextId, error, setError } = usePopupState();
  const [localAppState, setLocalAppState] = useState<AppState | null>(null);
  const mergedAppState = appState ?? localAppState;
  const setAppState = (state: AppState | null) => setLocalAppState(state);
  const [repo, setRepo] = useState<RepoRef | null>(null);
  const [notice, setNotice] = useState<string>('Connecting to APItiser worker...');
  const [testDirsInput, setTestDirsInput] = useState<string>('tests, __tests__, test');
  const [openApiFallbackInput, setOpenApiFallbackInput] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const [contextId, setContextIdLocal] = useState<string>('global');
  const [selectedEndpointIds, setSelectedEndpointIds] = useState<string[]>([]);
  const [methodFilter, setMethodFilter] = useState<string>('ALL');
  const contextRef = useRef<string>('global');
  const endpointSelectionSeedRef = useRef<string>('');

  const setContextId = (id: string) => {
    setContextIdLocal(id);
    setPopupContextId(id);
  };

  const activeOrLatestJob = useMemo(() => {
    if (!mergedAppState) return null;
    return mergedAppState.activeJob ?? mergedAppState.jobHistory[0] ?? null;
  }, [mergedAppState]);

  const selectedProvider = mergedAppState?.settings.provider ?? 'openai';
  const skipExistingEnabled = mergedAppState?.settings.skipExistingTests ?? true;
  const latestMetric = mergedAppState?.metricsHistory?.[0];
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
    if (!skipExistingEnabled) return selectedEndpointCount;
    return endpoints.filter((endpoint) => selectedEndpointSet.has(endpoint.id) && !existingCoveredSet.has(endpoint.id)).length;
  }, [skipExistingEnabled, endpoints, existingCoveredSet, selectedEndpointCount, selectedEndpointSet]);

  const resolveActiveTab = async (gitlabBaseUrl?: string) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const nextContextId = deriveContextIdFromTab(tab);
    contextRef.current = nextContextId;
    setContextId(nextContextId);
    if (!tab?.url) { setRepo(null); return nextContextId; }
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
      const nextContextId = await resolveActiveTab(mergedAppState?.settings.gitlabBaseUrl);
      await loadInitial(nextContextId);
    })();

    const refreshFromCurrentTab = async () => {
      const nextContextId = await resolveActiveTab(mergedAppState?.settings.gitlabBaseUrl);
      const snapshot = await sendCommand<EventMessage>({ type: 'GET_STATE', contextId: nextContextId });
      if (snapshot.type === 'STATE_SNAPSHOT' && nextContextId === contextRef.current) {
        setAppState(snapshot.payload);
      }
    };

    const handleTabActivated = () => { void refreshFromCurrentTab(); };
    const handleTabUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.status === 'complete') void refreshFromCurrentTab();
    };

    chrome.tabs.onActivated.addListener(handleTabActivated);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(handleTabActivated);
      chrome.tabs.onUpdated.removeListener(handleTabUpdated);
    };
  }, [mergedAppState?.settings.gitlabBaseUrl]);

  useEffect(() => {
    if (!mergedAppState) return;
    setTestDirsInput(mergedAppState.settings.testDirectories.join(', '));
  }, [mergedAppState?.settings.testDirectories]);

  useEffect(() => {
    if (!mergedAppState) return;
    setOpenApiFallbackInput(mergedAppState.settings.openApiFallbackSpec ?? '');
  }, [mergedAppState?.settings.openApiFallbackSpec]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [settingsOpen]);

  useEffect(() => {
    if (!endpointIds.length) { endpointSelectionSeedRef.current = ''; setSelectedEndpointIds([]); return; }
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
    if (!skipExistingEnabled || !existingCoveredSet.size) return;
    setSelectedEndpointIds((current) => {
      const filtered = current.filter((endpointId) => !existingCoveredSet.has(endpointId));
      return filtered.length === current.length ? current : filtered;
    });
  }, [skipExistingEnabled, existingCoveredSet]);

  const patchSettings = async (patch: Partial<AppState['settings']>) => {
    setError('');
    const response = await sendCommand<EventMessage>({ type: 'SAVE_SETTINGS', payload: patch, contextId });
    if (response.type === 'SETTINGS_SAVED') setAppState(response.payload);
  };

  const handleCategoryToggle = async (category: TestCategory) => {
    if (!mergedAppState) return;
    const current = new Set(mergedAppState.settings.includeCategories);
    current.has(category) ? current.delete(category) : current.add(category);
    const next = [...current];
    await patchSettings({ includeCategories: next.length ? next : ['positive'] });
  };

  const persistTestFoldersIfChanged = async () => {
    if (!mergedAppState) return;
    const normalizedDirs = testDirsInput.split(',').map((value) => value.trim()).filter(Boolean);
    if (normalizedDirs.join('|') !== mergedAppState.settings.testDirectories.join('|')) {
      await patchSettings({ testDirectories: normalizedDirs });
    }
  };

  const persistOpenApiFallbackIfChanged = async () => {
    if (!mergedAppState) return;
    const normalized = openApiFallbackInput.trim();
    const current = (mergedAppState.settings.openApiFallbackSpec ?? '').trim();
    if (normalized !== current) await patchSettings({ openApiFallbackSpec: normalized });
  };

  const handleValidateAccess = async () => {
    if (!repo) { setError('Open a GitHub or GitLab repository tab first.'); return; }
    await persistTestFoldersIfChanged();
    setError('');
    setNotice('Validating repository access and token scopes...');
    const response = await sendCommand<EventMessage>({ type: 'VALIDATE_REPO_ACCESS', payload: { repo }, contextId });
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    if (response.type === 'STATE_SNAPSHOT' || response.type === 'SETTINGS_SAVED' || response.type === 'JOB_PROGRESS' || response.type === 'JOB_COMPLETE') {
      setNotice(response.payload.lastValidation?.ok ? 'Validation passed' : 'Validation completed with issues');
    } else {
      setNotice('Validation completed');
    }
  };

  const handleScan = async () => {
    if (!repo) { setError('Open a GitHub or GitLab repository tab before scanning.'); return; }
    await persistTestFoldersIfChanged();
    await persistOpenApiFallbackIfChanged();
    setError('');
    setNotice('Scanning repository...');
    const response = await sendCommand<EventMessage>({ type: 'START_SCAN', payload: { repo }, contextId });
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    setNotice('Scan complete. Review endpoints and generate tests.');
  };

  const handleImportOpenApiFile = async (file: File | null | undefined) => {
    if (!file) return;
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
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    setNotice('Generation complete. Download your suite.');
  };

  const handleCancel = async () => {
    setError('');
    setNotice('Cancelling...');
    const response = await sendCommand<EventMessage>({ type: 'CANCEL_JOB', contextId });
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    if (response.type === 'STATE_SNAPSHOT') setAppState(response.payload);
    setNotice('Job cancelled');
  };

  const handleClear = async () => {
    setError('');
    const response = await sendCommand<EventMessage>({ type: 'CLEAR_CONTEXT', contextId });
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    if (response.type === 'STATE_SNAPSHOT') setAppState(response.payload);
    setNotice('Context cleared');
  };

  const handleDownload = async () => {
    const artifact = mergedAppState?.artifacts?.[0];
    if (!artifact) { setError('No generated artifact available for download.'); return; }
    const response = await sendCommand<EventMessage>({
      type: 'DOWNLOAD_ARTIFACT',
      payload: { artifactId: artifact.id },
      contextId
    });
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    setNotice(
      artifact.readiness === 'production_candidate'
        ? 'Validated download started'
        : `Download started${artifact.readiness ? ` (${artifact.readiness.replace(/_/g, ' ')})` : ''}`
    );
  };

  const handleExportPostman = async () => {
    const response = await sendCommand<EventMessage>({ type: 'EXPORT_POSTMAN', contextId });
    if (response.type === 'JOB_ERROR') { setError(response.error); return; }
    setNotice('Postman collection downloaded');
  };

  const handleExportSettings = () => {
    if (!mergedAppState) return;
    const {
      openAiKey,
      claudeKey,
      geminiKey,
      githubToken,
      gitlabToken,
      runtimeApiToken,
      runtimeApiKey,
      runtimeCsrfToken,
      runtimeSessionCookie,
      runtimeSetupSteps,
      ...safe
    } = mergedAppState.settings;
    void openAiKey; void claudeKey; void geminiKey; void githubToken; void gitlabToken;
    void runtimeApiToken; void runtimeApiKey; void runtimeCsrfToken; void runtimeSessionCookie; void runtimeSetupSteps;
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'apitiser-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSettings = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<AppState['settings']>;
      await patchSettings(parsed);
      setNotice('Settings imported');
    } catch {
      setError('Invalid settings file');
    }
  };

  const openExtensionDoc = async (path: 'help.html' | 'privacypolicy.html') => {
    const url = chrome.runtime.getURL(path);
    await chrome.tabs.create({ url });
  };

  const busy = ['scanning', 'parsing', 'generating', 'validating', 'packaging'].includes(activeOrLatestJob?.stage ?? 'idle');
  const batchDiagnostics = activeOrLatestJob?.batchDiagnostics ?? [];
  const latestBatchDiagnostic = batchDiagnostics[batchDiagnostics.length - 1];
  const qualityIssues = batchDiagnostics.flatMap((diagnostic) => diagnostic.assessment.issues);
  const visibleQualityIssues = qualityIssues.slice(0, 4);
  const qualityStatusLabel = activeOrLatestJob?.qualityStatus ?? (batchDiagnostics.length ? 'pending' : undefined);
  const generatedTests = activeOrLatestJob?.generatedTests ?? [];
  const readiness = activeOrLatestJob?.readiness ?? mergedAppState?.artifacts?.[0]?.readiness;
  const readinessNotes = activeOrLatestJob?.readinessNotes ?? mergedAppState?.artifacts?.[0]?.readinessNotes ?? [];

  return (
    <main className="shell" data-theme="light">
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
        <ErrorBoundary
          resetKeys={[settingsOpen]}
          fallback={(err, retry) => (
            <div className="error-boundary-fallback" role="alert">
              <h2>Settings failed to load</h2>
              <p className="error-boundary-message">{err.message}</p>
              <button type="button" onClick={() => { retry(); setSettingsOpen(false); }}>Close</button>
            </div>
          )}
        >
          <SettingsModal
            appState={mergedAppState}
            testDirsInput={testDirsInput}
            openApiFallbackInput={openApiFallbackInput}
            busy={busy}
            hasRepo={Boolean(repo)}
            onClose={() => setSettingsOpen(false)}
            onPatchSettings={(patch) => void patchSettings(patch)}
            onTestDirsChange={setTestDirsInput}
            onOpenApiFallbackChange={setOpenApiFallbackInput}
            onCategoryToggle={(category) => void handleCategoryToggle(category)}
            onValidateAccess={() => void handleValidateAccess()}
            onPersistTestFolders={() => void persistTestFoldersIfChanged()}
            onPersistOpenApiFallback={() => void persistOpenApiFallbackIfChanged()}
            onImportOpenApiFile={(file) => void handleImportOpenApiFile(file)}
            onOpenDoc={(path) => void openExtensionDoc(path)}
            onExportSettings={handleExportSettings}
            onImportSettings={(file) => void handleImportSettings(file)}
          />
        </ErrorBoundary>
      ) : null}

      {previewOpen && generatedTests.length > 0 ? (
        <ErrorBoundary
          resetKeys={[previewOpen]}
          fallback={(err, retry) => (
            <div className="error-boundary-fallback" role="alert">
              <h2>Preview failed to render</h2>
              <p className="error-boundary-message">{err.message}</p>
              <button type="button" onClick={() => { retry(); setPreviewOpen(false); }}>Close</button>
            </div>
          )}
        >
          <TestPreviewModal
            tests={generatedTests}
            endpoints={endpoints}
            onClose={() => setPreviewOpen(false)}
          />
        </ErrorBoundary>
      ) : null}

      <ProgressTimeline
        activeOrLatestJob={activeOrLatestJob}
        visibleQualityIssues={visibleQualityIssues}
        qualityStatusLabel={qualityStatusLabel}
        latestBatchDiagnostic={latestBatchDiagnostic}
      />

      <EndpointList
        endpoints={endpoints}
        selectedEndpointSet={selectedEndpointSet}
        existingCoveredSet={existingCoveredSet}
        selectedEndpointCount={selectedEndpointCount}
        selectedEligibleCount={selectedEligibleCount}
        skipExistingEnabled={skipExistingEnabled}
        busy={busy}
        methodFilter={methodFilter}
        onMethodFilterChange={setMethodFilter}
        onEndpointToggle={(id, checked) =>
          setSelectedEndpointIds((current) =>
            checked
              ? current.includes(id) ? current : [...current, id]
              : current.filter((v) => v !== id)
          )
        }
        onSelectAll={() => {
          if (!skipExistingEnabled) { setSelectedEndpointIds(endpointIds); return; }
          setSelectedEndpointIds(endpoints.filter((ep) => !existingCoveredSet.has(ep.id)).map((ep) => ep.id));
        }}
        onClearAll={() => setSelectedEndpointIds([])}
        activeOrLatestJob={activeOrLatestJob}
      />

      <CoveragePanel activeOrLatestJob={activeOrLatestJob} />
      <PerformancePanel latestMetric={latestMetric} />

      {generatedTests.length > 0 && activeOrLatestJob?.stage === 'complete' ? (
        <div className="preview-trigger-row">
          <button type="button" className="ghost utility-btn" onClick={() => setPreviewOpen(true)}>
            👁 Preview Tests ({generatedTests.length})
          </button>
        </div>
      ) : null}

      <ActionFooter
        busy={busy}
        hasRepo={Boolean(repo)}
        hasEndpoints={endpoints.length > 0}
        hasArtifact={Boolean(mergedAppState?.artifacts.length)}
        skipExistingEnabled={skipExistingEnabled}
        selectedEligibleCount={selectedEligibleCount}
        selectedEndpointCount={selectedEndpointCount}
        onScan={() => void handleScan()}
        onGenerate={() => void handleGenerate()}
        onDownload={() => void handleDownload()}
        onCancel={() => void handleCancel()}
        onClear={() => void handleClear()}
        onExportPostman={() => void handleExportPostman()}
        jobStage={activeOrLatestJob?.stage}
        readiness={readiness}
        readinessNotes={readinessNotes}
      />
    </main>
  );
}
