/// <reference lib="webworker" />

import type { AppState, JobState, RepoRef, RunMetric } from '@shared/types';
import type { CommandMessage, EventMessage } from '@shared/messages';
import { parseApiMap } from './parser/apiParser';
import { applyOpenApiFallback } from './parser/scanInput';
import { detectExistingTestCoverage } from './parser/testCoverageDetector';
import { scanRepositoryFiles } from './repo/scanner';
import { validateRepoAccess } from './repo/validator';
import { buildCoverage } from './generation/coverage';
import { buildArtifactZip } from './generation/zipBuilder';
import { applyGenerationProgressToJob, BatchGenerationError, generateTestSuite, renderGeneratedFiles } from './generation/testGenerator';
import { clearBadge, updateBadgeForJob } from './core/badge';
import {
  clearContext,
  completeJob,
  getArtifactById,
  loadAllStates,
  loadState,
  replaceActiveJob,
  saveState,
  setActiveJob,
  setLastValidation,
  updateSettings
} from './core/stateManager';
import { emitComplete, emitError, emitProgress, emitStateSnapshot } from './core/emitter';
import { notify } from './core/notifier';
import { registerKeepAliveListener, startKeepAlive, stopKeepAlive } from './core/keepAlive';
import { createId } from './utils/id';

let activeAbortController: AbortController | null = null;
let generationInFlight = false;
let scanInFlight = false;
let autoResumeStarted = false;
const clearedContexts = new Set<string>();
const sidePanelPath = 'sidepanel.html';

const hasSidePanelApi = (): boolean => typeof chrome.sidePanel !== 'undefined';
const resolveContextId = (contextId?: string): string => contextId?.trim() || 'global';
const isContextCleared = (contextId: string): boolean => clearedContexts.has(contextId);

const configureSidePanelDefaults = async (): Promise<void> => {
  if (!hasSidePanelApi()) {
    return;
  }

  try {
    await chrome.sidePanel.setOptions({
      path: sidePanelPath,
      enabled: true
    });
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true
    });
  } catch (error) {
    console.warn('Side panel configuration failed:', error);
  }
};

const ensureSidePanelForTab = async (tabId: number): Promise<void> => {
  if (!hasSidePanelApi()) {
    return;
  }

  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: sidePanelPath,
      enabled: true
    });
  } catch (error) {
    console.warn('Side panel tab options failed:', error);
  }
};

const openSidePanelForTab = async (tabId: number): Promise<void> => {
  if (!hasSidePanelApi()) {
    return;
  }

  try {
    await ensureSidePanelForTab(tabId);
    await chrome.sidePanel.open({ tabId });
  } catch (error) {
    console.warn('Side panel open failed:', error);
  }
};

const getStateSnapshot = async (contextId?: string): Promise<AppState> => {
  const state = await loadState(contextId);
  updateBadgeForJob(state.activeJob);
  return state;
};

const checkpoint = async (job: JobState, contextId?: string): Promise<AppState> => {
  const state = await replaceActiveJob(job, contextId);
  updateBadgeForJob(state.activeJob);
  emitProgress(state, contextId);
  return state;
};

const repoLabel = (repo?: RepoRef): string | undefined =>
  repo ? `${repo.platform}:${repo.owner}/${repo.repo}` : undefined;

const buildMetric = (
  job: JobState,
  status: 'complete' | 'error' | 'cancelled',
  completedAt: number,
  framework?: AppState['settings']['framework']
): RunMetric => {
  const scanMs = job.timings?.scanStartedAt && job.timings?.scanCompletedAt
    ? job.timings.scanCompletedAt - job.timings.scanStartedAt
    : undefined;

  const generationMs = job.timings?.generationStartedAt && job.timings?.generationCompletedAt
    ? job.timings.generationCompletedAt - job.timings.generationStartedAt
    : undefined;

  return {
    jobId: job.jobId,
    status,
    provider: job.activeProvider,
    framework,
    repo: repoLabel(job.repo),
    startedAt: job.startedAt,
    completedAt,
    scanMs,
    generationMs,
    totalMs: completedAt - job.startedAt,
    endpointsDetected: job.totalEndpoints,
    testsGenerated: job.generatedTests.length,
    coveragePercent: job.coverage?.coveragePercent
  };
};

const requiredProviderKey = (state: AppState): string => {
  if (state.settings.provider === 'openai') {
    return state.settings.openAiKey ?? '';
  }
  if (state.settings.provider === 'claude') {
    return state.settings.claudeKey ?? '';
  }
  return state.settings.geminiKey ?? '';
};

const resolveQueuedEndpoints = (job: JobState): JobState['endpoints'] => {
  if (!job.queuedEndpointIds?.length) {
    return job.endpoints;
  }

  const queued = new Set(job.queuedEndpointIds);
  return job.endpoints.filter((endpoint) => queued.has(endpoint.id));
};

const completeWithError = async (
  job: JobState,
  error: unknown,
  framework?: AppState['settings']['framework'],
  contextId?: string
): Promise<AppState> => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const completedAt = Date.now();
  const failed: JobState = {
    ...job,
    stage: 'error',
    statusText: message,
    error: message,
    qualityStatus: 'failed',
    updatedAt: completedAt,
    timings: {
      ...job.timings,
      generationCompletedAt: job.timings?.generationCompletedAt ?? completedAt
    }
  };

  await stopKeepAlive();
  const metric = buildMetric(failed, 'error', completedAt, framework);
  const state = await completeJob(failed, undefined, metric, contextId);
  updateBadgeForJob(failed);
  notify('APItiser generation failed', message);
  emitError(state, message, contextId);
  return state;
};

const completeWithCancel = async (
  job: JobState,
  framework?: AppState['settings']['framework'],
  contextId?: string
): Promise<AppState> => {
  const completedAt = Date.now();
  const cancelled: JobState = {
    ...job,
    stage: 'cancelled',
    statusText: 'Job cancelled by user',
    updatedAt: completedAt,
    timings: {
      ...job.timings,
      generationCompletedAt: job.timings?.generationCompletedAt ?? completedAt
    }
  };

  await stopKeepAlive();
  const metric = buildMetric(cancelled, 'cancelled', completedAt, framework);
  const state = await completeJob(cancelled, undefined, metric, contextId);
  updateBadgeForJob(cancelled);
  emitProgress(state, contextId);
  return state;
};

const finalizeGeneration = async (
  state: AppState,
  job: JobState,
  tests: JobState['generatedTests'],
  endpointCount: number,
  contextId?: string
): Promise<AppState> => {
  if (contextId && isContextCleared(contextId)) {
    await stopKeepAlive();
    return await loadState(contextId);
  }

  const packaging: JobState = {
    ...job,
    stage: 'packaging',
    progress: 92,
    statusText: 'Packaging generated tests',
    updatedAt: Date.now()
  };

  await checkpoint(packaging, contextId);

  const files = renderGeneratedFiles(state.settings, packaging.repo!, endpointCount, tests);
  const artifact = await buildArtifactZip(state.settings.framework, files);
  const completedAt = Date.now();

  const coverage = buildCoverage(
    packaging.endpoints,
    tests,
    packaging.existingTestEndpointIds ?? [],
    state.settings.includeCategories
  );

  const complete: JobState = {
    ...packaging,
    stage: 'complete',
    progress: 100,
    statusText: `Completed with ${coverage.testsGenerated} tests`,
    coverage,
    generatedTests: tests,
    qualityStatus: 'passed',
    artifactId: artifact.id,
    updatedAt: completedAt,
    timings: {
      ...packaging.timings,
      generationCompletedAt: completedAt
    }
  };

  await stopKeepAlive();
  const metric = buildMetric(complete, 'complete', completedAt, state.settings.framework);
  const finalState = await completeJob(complete, artifact, metric, contextId);
  updateBadgeForJob(complete);
  notify('APItiser ready', 'Generated tests are ready to download.');
  emitComplete(finalState, contextId);
  return finalState;
};

const executeGeneration = async (
  state: AppState,
  job: JobState,
  endpointsToGenerate: JobState['endpoints'],
  startBatch = 0,
  initialTests: JobState['generatedTests'] = [],
  contextId?: string
): Promise<AppState> => {
  generationInFlight = true;
  if (contextId) {
    clearedContexts.delete(contextId);
  }
  activeAbortController = new AbortController();

  await startKeepAlive();

  try {
    if (endpointsToGenerate.length > 0 && startBatch < Math.ceil(endpointsToGenerate.length / state.settings.batchSize)) {
      const generationResult = await generateTestSuite({
        settings: state.settings,
        repo: job.repo!,
        endpoints: endpointsToGenerate,
        startBatch,
        initialTests,
        signal: activeAbortController.signal,
        onBatchComplete: async (progress) => {
          if (contextId && isContextCleared(contextId)) {
            throw new Error('Context cleared');
          }
          const currentState = await loadState(contextId);
          const currentJob = currentState.activeJob ?? job;
          const nextJob = applyGenerationProgressToJob(currentJob, progress);
          await checkpoint(nextJob, contextId);
        },
        onBatchHeartbeat: async (heartbeat) => {
          if (contextId && isContextCleared(contextId)) {
            return;
          }
          const elapsedSec = Math.round(heartbeat.elapsedMs / 1000);
          const currentState = await loadState(contextId);
          const currentJob = currentState.activeJob ?? job;
          const beating: JobState = {
            ...currentJob,
            statusText: `Generating batch ${heartbeat.currentBatch + 1}/${heartbeat.totalBatches} — ${elapsedSec}s elapsed (${heartbeat.attempt})`,
            updatedAt: Date.now()
          };
          emitProgress(await replaceActiveJob(beating, contextId), contextId);
        }
      });
      const currentJob = (await loadState(contextId)).activeJob ?? job;
      const existingDiagnostics = currentJob.batchDiagnostics ?? [];
      const mergedDiagnostics = [...existingDiagnostics];

      for (const diagnostic of generationResult.diagnostics) {
        if (!mergedDiagnostics.some((item) => item.batchIndex === diagnostic.batchIndex)) {
          mergedDiagnostics.push(diagnostic);
        }
      }

      return await finalizeGeneration(
        state,
        {
          ...currentJob,
          batchDiagnostics: mergedDiagnostics,
          qualityStatus: 'passed'
        },
        generationResult.tests,
        endpointsToGenerate.length,
        contextId
      );
    }

    return await finalizeGeneration(state, job, initialTests, endpointsToGenerate.length, contextId);
  } catch (error) {
    if (contextId && isContextCleared(contextId)) {
      await stopKeepAlive();
      return await loadState(contextId);
    }
    const snapshot = (await loadState(contextId)).activeJob ?? job;
    const qualitySnapshot = error instanceof BatchGenerationError
      ? {
          ...snapshot,
          batchDiagnostics: [...(snapshot.batchDiagnostics ?? []), error.diagnostics],
          qualityStatus: 'failed' as const,
          repairAttempts: (snapshot.repairAttempts ?? 0) + (error.diagnostics.repairAttempted ? 1 : 0),
          statusText: error.diagnostics.assessment.issues[0]?.message ?? snapshot.statusText
        }
      : snapshot;
    return await completeWithError(qualitySnapshot, error, state.settings.framework, contextId);
  } finally {
    activeAbortController = null;
    generationInFlight = false;
  }
};

const runScanPipeline = async (
  state: AppState,
  repo: RepoRef,
  contextId: string,
  options?: { resumeFromJob?: JobState }
): Promise<AppState> => {
  if (scanInFlight) {
    throw new Error('Scan is already in progress.');
  }

  scanInFlight = true;
  clearedContexts.delete(contextId);
  await startKeepAlive();

  const now = Date.now();
  const resumeJob = options?.resumeFromJob;
  const scanningJob: JobState = resumeJob
    ? {
        ...resumeJob,
        stage: 'scanning',
        statusText: 'Resuming repository scan from checkpoint',
        resumedFromCheckpoint: true,
        updatedAt: now,
        timings: {
          ...resumeJob.timings,
          scanStartedAt: resumeJob.timings?.scanStartedAt ?? resumeJob.startedAt
        }
      }
    : {
        jobId: createId('job'),
        stage: 'scanning',
        startedAt: now,
        updatedAt: now,
        repo,
        progress: 5,
        statusText: 'Scanning repository files',
        totalEndpoints: 0,
        completedBatches: 0,
        totalBatches: 0,
        endpoints: [],
        generatedTests: [],
        existingTestEndpointIds: [],
        eligibleEndpointCount: 0,
        activeProvider: state.settings.provider,
        timings: {
          scanStartedAt: now
        }
      };

  await setActiveJob(scanningJob, contextId);
  updateBadgeForJob(scanningJob);
  emitProgress(await getStateSnapshot(contextId), contextId);

  try {
    const files = await scanRepositoryFiles(repo, {
      githubToken: state.settings.githubToken,
      gitlabToken: state.settings.gitlabToken
    });

    if (isContextCleared(contextId)) {
      await stopKeepAlive();
      return await loadState(contextId);
    }

    const withFallback = applyOpenApiFallback(files, state.settings.openApiFallbackSpec);

    const parsingJob: JobState = {
      ...scanningJob,
      stage: 'parsing',
      progress: 60,
      statusText: `Parsing ${withFallback.files.length} files for API routes`,
      updatedAt: Date.now()
    };

    await checkpoint(parsingJob, contextId);

    const endpoints = parseApiMap(withFallback.files);
    const existingTestEndpointIds = detectExistingTestCoverage(withFallback.files, endpoints, state.settings.testDirectories);
    const eligibleEndpointCount = state.settings.skipExistingTests
      ? Math.max(endpoints.length - existingTestEndpointIds.length, 0)
      : endpoints.length;
    const preGenerationCoverage = buildCoverage(
      endpoints,
      [],
      existingTestEndpointIds,
      state.settings.includeCategories
    );

    if (isContextCleared(contextId)) {
      await stopKeepAlive();
      return await loadState(contextId);
    }

    const completedAt = Date.now();
    const fallbackLabel = withFallback.usedFallback ? ' + manual OpenAPI fallback' : '';
    const completedScan: JobState = {
      ...parsingJob,
      stage: 'idle',
      progress: 100,
      totalEndpoints: endpoints.length,
      endpoints,
      existingTestEndpointIds,
      eligibleEndpointCount,
      coverage: preGenerationCoverage,
      statusText: `Scan complete: ${endpoints.length} APIs (${existingTestEndpointIds.length} already tested${fallbackLabel})`,
      updatedAt: completedAt,
      timings: {
        ...parsingJob.timings,
        scanCompletedAt: completedAt
      }
    };

    await stopKeepAlive();
    const nextState = await replaceActiveJob(completedScan, contextId);
    updateBadgeForJob(completedScan);
    emitProgress(nextState, contextId);

    notify(
      'APItiser scan complete',
      `${eligibleEndpointCount} APIs queued for generation${withFallback.usedFallback ? ' (with OpenAPI fallback)' : ''}`
    );
    return nextState;
  } catch (error) {
    if (isContextCleared(contextId)) {
      await stopKeepAlive();
      return await loadState(contextId);
    }
    return await completeWithError(scanningJob, error, state.settings.framework, contextId);
  } finally {
    scanInFlight = false;
  }
};

const handleStartScan = async (command: Extract<CommandMessage, { type: 'START_SCAN' }>): Promise<AppState> => {
  const contextId = resolveContextId(command.contextId);
  const state = await loadState(contextId);
  return await runScanPipeline(state, command.payload.repo, contextId);
};

const handleStartGeneration = async (
  command: Extract<CommandMessage, { type: 'START_GENERATION' }>
): Promise<AppState> => {
  const contextId = resolveContextId(command.contextId);
  const state = await loadState(contextId);
  if (!state.activeJob?.repo || state.activeJob.endpoints.length === 0) {
    throw new Error('No scanned endpoints available. Run Scan Repo first.');
  }

  if (generationInFlight) {
    throw new Error('Generation is already in progress.');
  }

  const hasExplicitSelection = Array.isArray(command.payload?.selectedEndpointIds);
  const selectedEndpointIds = command.payload?.selectedEndpointIds ?? [];
  const selectedEndpointSet = hasExplicitSelection ? new Set(selectedEndpointIds) : null;
  const selectedEndpoints = hasExplicitSelection
    ? state.activeJob.endpoints.filter((endpoint) => selectedEndpointSet?.has(endpoint.id))
    : state.activeJob.endpoints;

  const existingCovered = new Set(state.activeJob.existingTestEndpointIds ?? []);
  const endpointsToGenerate = state.settings.skipExistingTests
    ? selectedEndpoints.filter((endpoint) => !existingCovered.has(endpoint.id))
    : selectedEndpoints;

  if (endpointsToGenerate.length > 0) {
    const key = requiredProviderKey(state);
    if (!key) {
      throw new Error(`Missing API key for ${state.settings.provider}`);
    }
  }

  const generating: JobState = {
    ...state.activeJob,
    stage: 'generating',
    statusText: `Generating tests for ${endpointsToGenerate.length} endpoints`,
    progress: 65,
    completedBatches: 0,
    totalBatches: 0,
    generatedTests: [],
    batchDiagnostics: [],
    eligibleEndpointCount: endpointsToGenerate.length,
    queuedEndpointIds: endpointsToGenerate.map((endpoint) => endpoint.id),
    activeProvider: state.settings.provider,
    qualityStatus: 'pending',
    repairAttempts: 0,
    resumedFromCheckpoint: false,
    updatedAt: Date.now(),
    timings: {
      ...state.activeJob.timings,
      generationStartedAt: Date.now()
    }
  };

  await checkpoint(generating, contextId);
  return await executeGeneration(state, generating, endpointsToGenerate, 0, [], contextId);
};

const handleCancel = async (contextId: string): Promise<AppState> => {
  activeAbortController?.abort();
  activeAbortController = null;

  const state = await loadState(contextId);
  if (!state.activeJob) {
    return state;
  }

  return await completeWithCancel(state.activeJob, state.settings.framework, contextId);
};

const handleDownload = async (artifactId: string, contextId: string): Promise<EventMessage> => {
  const artifact = await getArtifactById(artifactId, contextId);
  if (!artifact) {
    throw new Error('Artifact not found');
  }

  await chrome.downloads.download({
    filename: artifact.fileName,
    saveAs: true,
    url: `data:application/zip;base64,${artifact.zipBase64}`
  });

  return {
    type: 'ARTIFACT_DOWNLOADED',
    payload: artifact,
    contextId
  };
};

const handleValidateRepoAccess = async (
  command: Extract<CommandMessage, { type: 'VALIDATE_REPO_ACCESS' }>
): Promise<AppState> => {
  const contextId = resolveContextId(command.contextId);
  const state = await loadState(contextId);
  const result = await validateRepoAccess(command.payload.repo, {
    githubToken: state.settings.githubToken,
    gitlabToken: state.settings.gitlabToken
  });

  const next = await setLastValidation(result, contextId);
  emitStateSnapshot(next, contextId);
  return next;
};

const handleClearContext = async (contextId: string): Promise<AppState> => {
  clearedContexts.add(contextId);
  activeAbortController?.abort();
  activeAbortController = null;
  await stopKeepAlive();
  const next = await clearContext(contextId);
  updateBadgeForJob(next.activeJob);
  emitStateSnapshot(next, contextId);
  return next;
};

const autoResumeActiveJob = async (): Promise<void> => {
  if (autoResumeStarted) {
    return;
  }
  autoResumeStarted = true;

  const allStates = await loadAllStates();
  const resumable = Object.values(allStates).find((state) => Boolean(state.activeJob));
  if (!resumable || generationInFlight || scanInFlight) {
    return;
  }
  const state = resumable;
  const contextId = state.contextId ?? 'global';
  const job = state.activeJob!;

  if (job.stage === 'generating') {
    const queuedEndpoints = resolveQueuedEndpoints(job);
    const remaining = Math.max(queuedEndpoints.length - job.completedBatches * state.settings.batchSize, 0);

    if (remaining > 0) {
      const key = requiredProviderKey(state);
      if (!key) {
        await completeWithError(job, new Error('Cannot resume generation: missing provider API key.'), state.settings.framework, contextId);
        return;
      }
    }

    const resumed: JobState = {
      ...job,
      resumedFromCheckpoint: true,
      statusText: `Resuming generation from batch ${Math.max(job.completedBatches + 1, 1)}`,
      updatedAt: Date.now()
    };

    await checkpoint(resumed, contextId);
    void executeGeneration(state, resumed, queuedEndpoints, resumed.completedBatches, resumed.generatedTests, contextId);
    return;
  }

  if (job.stage === 'packaging') {
    const resumed: JobState = {
      ...job,
      resumedFromCheckpoint: true,
      statusText: 'Resuming packaging from checkpoint',
      updatedAt: Date.now()
    };
    await checkpoint(resumed, contextId);
    void finalizeGeneration(state, resumed, resumed.generatedTests, resolveQueuedEndpoints(resumed).length, contextId);
    return;
  }

  if (job.stage === 'scanning' || job.stage === 'parsing') {
    if (!job.repo) {
      await completeWithError(job, new Error('Scan checkpoint is missing repository context.'), state.settings.framework, contextId);
      return;
    }
    void runScanPipeline(state, job.repo, contextId, { resumeFromJob: job });
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  await saveState(state);
  clearBadge();
  await configureSidePanelDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanelDefaults();
  void autoResumeActiveJob();
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    void openSidePanelForTab(tab.id);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ensureSidePanelForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void ensureSidePanelForTab(tabId);
  }
});

registerKeepAliveListener();
void configureSidePanelDefaults();
void autoResumeActiveJob();

chrome.runtime.onMessage.addListener((message: CommandMessage, _sender, sendResponse) => {
  const run = async (): Promise<void> => {
    try {
      const contextId = resolveContextId(message.contextId);

      if (message.type === 'GET_STATE') {
        sendResponse({ type: 'STATE_SNAPSHOT', payload: await getStateSnapshot(contextId), contextId } as EventMessage);
        return;
      }

      if (message.type === 'SAVE_SETTINGS') {
        const next = await updateSettings(message.payload, contextId);
        emitStateSnapshot(next, contextId);
        sendResponse({ type: 'SETTINGS_SAVED', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'VALIDATE_REPO_ACCESS') {
        const next = await handleValidateRepoAccess(message);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'START_SCAN') {
        const next = await handleStartScan(message);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'START_GENERATION') {
        const next = await handleStartGeneration(message);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'CANCEL_JOB') {
        const next = await handleCancel(contextId);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'CLEAR_CONTEXT') {
        const next = await handleClearContext(contextId);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'DOWNLOAD_ARTIFACT') {
        sendResponse(await handleDownload(message.payload.artifactId, contextId));
        return;
      }

      sendResponse({ type: 'ACK' } as EventMessage);
    } catch (error) {
      const contextId = resolveContextId(message.contextId);
      const state = await getStateSnapshot(contextId);
      const messageText = error instanceof Error ? error.message : 'Unknown error';
      sendResponse({ type: 'JOB_ERROR', payload: state, error: messageText, contextId } as EventMessage);
    }
  };

  void run();
  return true;
});
