/// <reference lib="webworker" />

import type {
  AppState,
  CodeFixProposal,
  ExtensionSettings,
  JobState,
  LocalServiceState,
  RepoRef,
  RunMetric,
  ValidationResult,
  ValidationSummary
} from '@shared/types';
import type { CommandMessage, EventMessage } from '@shared/messages';
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
  setLocalService,
  addArtifact,
  updateSettings
} from './core/stateManager';
import { emitComplete, emitError, emitProgress, emitStateSnapshot } from './core/emitter';
import { notify } from './core/notifier';
import { registerKeepAliveListener, startKeepAlive, stopKeepAlive } from './core/keepAlive';
import { createId } from './utils/id';
import { parseApiMap } from './parser/apiParser';
import { consolidateAuth } from './parser/authConsolidation';
import { applyOpenApiFallback } from './parser/scanInput';
import { detectExistingTestCoverage } from './parser/testCoverageDetector';
import { scanRepositoryFiles } from './repo/scanner';
import { validateRepoAccess, validateRepoToken } from './repo/validator';
import { buildCoverage } from './generation/coverage';
import { suggestFramework } from './generation/frameworkSuggest';
import { buildArtifactZip } from './generation/zipBuilder';
import { assessReadiness } from './generation/readiness';
import { assessGeneratedTestQuality } from './generation/qualityGate';
import { buildPostmanCollection } from './generation/postmanExport';
import { buildSkippedSummary, validateGeneratedTestsAgainstBaseUrl } from './generation/executionValidator';
import { liveSummary, mergeValidationSummary, selectTestsForEndpoints } from './generation/endpointRun';
import { hasRepairableFailures } from './generation/failureTriage';
import { applyTestFix, proposeTestFix } from './fixes/testFix';
import { proposeCodeFix } from './fixes/codeFix';
import { getRunningService, staleServiceState, startLocalService, stopLocalService } from './runner/localSession';
import { apiDirHint, bootRepoFor } from './runner/bootTarget';
import { isLoopbackUrl } from '@shared/localUrl';
import { LOCAL_LLM_KEY, providerKeyFor } from '@shared/localLlm';
import { modelListRequest, parseModelList } from './llm/modelList';
import { estimateCostUsd } from './llm/pricing';
import { bootRepoService, hostRequest, pickFolder, pingHost, runRepoTests, runGeneratedSuite } from './runner/localRunner';
import { suiteCommandsFor } from './runner/suiteCommands';
import { buildRunnerZipBase64, runnerZipFileName } from './runner/runnerPackage';
import { getPlatform } from '@shared/platform';
import {
  applyGenerationProgressToJob,
  generateTestSuite,
  renderGeneratedFiles,
  repairTestsFromValidation
} from './generation/testGenerator';

const generationAbortControllers = new Map<string, AbortController>();
const scanAbortControllers = new Map<string, AbortController>();
const localRunAbortControllers = new Map<string, AbortController>();
const generationInFlightContexts = new Set<string>();
const scanInFlightContexts = new Set<string>();
const cancelledContexts = new Set<string>();
const keepAliveHolds = new Set<string>();
let autoResumeStarted = false;
const clearedContexts = new Set<string>();
const sidePanelPath = 'sidepanel.html';

const hasSidePanelApi = (): boolean => typeof chrome.sidePanel !== 'undefined';
const resolveContextId = (contextId?: string): string => contextId?.trim() || 'global';
const isContextCleared = (contextId: string): boolean => clearedContexts.has(contextId);
const isContextCancelled = (contextId: string): boolean => cancelledContexts.has(contextId);
const generationHoldKey = (contextId: string): string => `generation:${contextId}`;
const scanHoldKey = (contextId: string): string => `scan:${contextId}`;

const acquireKeepAlive = async (holdKey: string): Promise<void> => {
  if (keepAliveHolds.has(holdKey)) {
    return;
  }

  const shouldStart = keepAliveHolds.size === 0;
  keepAliveHolds.add(holdKey);

  if (shouldStart) {
    await startKeepAlive();
  }
};

const releaseKeepAlive = async (holdKey: string): Promise<void> => {
  if (!keepAliveHolds.delete(holdKey)) {
    return;
  }

  if (keepAliveHolds.size === 0) {
    await stopKeepAlive();
  }
};

const beginGenerationExecution = async (contextId: string): Promise<AbortController> => {
  if (generationInFlightContexts.has(contextId)) {
    throw new Error('Generation is already in progress.');
  }

  const controller = new AbortController();
  generationInFlightContexts.add(contextId);
  generationAbortControllers.set(contextId, controller);
  await acquireKeepAlive(generationHoldKey(contextId));
  return controller;
};

const finishGenerationExecution = async (contextId: string): Promise<void> => {
  generationAbortControllers.delete(contextId);
  if (generationInFlightContexts.delete(contextId)) {
    await releaseKeepAlive(generationHoldKey(contextId));
  }
};

const beginScanExecution = async (contextId: string): Promise<AbortController> => {
  if (scanInFlightContexts.has(contextId)) {
    throw new Error('Scan is already in progress.');
  }

  const controller = new AbortController();
  scanInFlightContexts.add(contextId);
  scanAbortControllers.set(contextId, controller);
  await acquireKeepAlive(scanHoldKey(contextId));
  return controller;
};

const finishScanExecution = async (contextId: string): Promise<void> => {
  scanAbortControllers.delete(contextId);
  if (scanInFlightContexts.delete(contextId)) {
    await releaseKeepAlive(scanHoldKey(contextId));
  }
};

const configureSidePanelDefaults = async (): Promise<void> => {
  if (!hasSidePanelApi()) {
    return;
  }

  try {
    // Per-tab side panel. We deliberately do NOT enable a global panel or use
    // openPanelOnActionClick — both make Chrome open a SINGLE global panel that stays visible as
    // the user switches tabs ("opens in all tabs"). Instead we disable the global default and
    // open the panel ourselves, scoped to the clicked tab, in chrome.action.onClicked.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch (error) {
    console.warn('Side panel configuration failed:', error);
  }
};

const openSidePanelForTab = (tabId: number): void => {
  if (!hasSidePanelApi()) {
    return;
  }

  // chrome.sidePanel.open() MUST be invoked synchronously within the action-click gesture —
  // any `await` before it drops the gesture and Chrome rejects the call, so nothing opens.
  // Enable the panel for this tab and open it in the same synchronous tick (order matters:
  // the global default is disabled, so the tab must be enabled before open resolves).
  try {
    void chrome.sidePanel.setOptions({ tabId, path: sidePanelPath, enabled: true });
  } catch (error) {
    console.warn('Side panel setOptions failed:', error);
  }
  try {
    const opened = chrome.sidePanel.open({ tabId }) as Promise<void> | undefined;
    if (opened && typeof opened.catch === 'function') {
      opened.catch((error) => console.warn('Side panel open failed:', error));
    }
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

const isBatchGenerationFailure = (
  error: unknown
): error is { diagnostics: NonNullable<JobState['batchDiagnostics']>[number]; partialTests: JobState['generatedTests'] } =>
  error !== null
  && typeof error === 'object'
  && 'diagnostics' in error
  && 'partialTests' in error;

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
    coveragePercent: job.coverage?.coveragePercent,
    tokensIn: job.tokenUsage?.inputTokens,
    tokensOut: job.tokenUsage?.outputTokens,
    costEstimateUsd: job.costEstimateUsd
  };
};

const requiredProviderKey = (state: AppState): string => providerKeyFor(state.settings, state.settings.provider);

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
  validationSummary?: JobState['validationSummary'],
  contextId?: string
): Promise<AppState> => {
  if (contextId && isContextCleared(contextId)) {
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

  const readinessAssessment = assessReadiness(tests, validationSummary);
  const files = renderGeneratedFiles(state.settings, packaging.repo!, endpointCount, tests, {
    readiness: readinessAssessment.readiness,
    readinessNotes: readinessAssessment.notes,
    validationSummary
  });
  const artifact = await buildArtifactZip(state.settings.framework, files, {
    readiness: readinessAssessment.readiness,
    readinessNotes: readinessAssessment.notes,
    validationSummary
  });
  const completedAt = Date.now();

  const coverage = buildCoverage(
    packaging.endpoints,
    tests,
    packaging.existingTestEndpointIds ?? [],
    state.settings.includeCategories
  );

  // Quality gate reflects BOTH generation completeness and live validation:
  //  - failed  : live validation ran and some tests failed against the API
  //  - partial : some endpoints lack tests / a required category (error-severity gaps)
  //  - passed  : every endpoint has the required coverage (and validation, if run, passed)
  // Skipping validation alone is NOT a failure — that's surfaced via readiness instead.
  const generationAssessment = assessGeneratedTestQuality(
    packaging.endpoints,
    tests,
    state.settings.includeCategories
  );
  const qualityStatus: JobState['qualityStatus'] = validationSummary?.failed
    ? 'failed'
    : generationAssessment.passed
      ? 'passed'
      : 'partial';

  const complete: JobState = {
    ...packaging,
    stage: 'complete',
    progress: 100,
    statusText: `Completed with ${coverage.testsGenerated} tests • ${readinessAssessment.readiness.replace(/_/g, ' ')}`,
    coverage,
    generatedTests: tests,
    qualityStatus,
    validationSummary,
    readiness: readinessAssessment.readiness,
    readinessNotes: readinessAssessment.notes,
    artifactId: artifact.id,
    updatedAt: completedAt,
    timings: {
      ...packaging.timings,
      generationCompletedAt: completedAt
    }
  };

  const metric = buildMetric(complete, 'complete', completedAt, state.settings.framework);
  const finalState = await completeJob(complete, artifact, metric, contextId);
  updateBadgeForJob(complete);
  notify(
    'APItiser ready',
    readinessAssessment.readiness === 'production_candidate'
      ? 'Generated tests validated as a production candidate.'
      : 'Generated tests are ready to download with readiness guidance.'
  );
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
  const contextKey = resolveContextId(contextId);
  cancelledContexts.delete(contextKey);
  clearedContexts.delete(contextKey);
  const activeAbortController = await beginGenerationExecution(contextKey);

  try {
    let finalTests = initialTests;
    let finalJob = job;

    if (endpointsToGenerate.length > 0 && startBatch < Math.ceil(endpointsToGenerate.length / state.settings.batchSize)) {
      const generationResult = await generateTestSuite({
        settings: state.settings,
        repo: job.repo!,
        endpoints: endpointsToGenerate,
        startBatch,
        initialTests,
        signal: activeAbortController.signal,
        onBatchComplete: async (progress) => {
          if (isContextCleared(contextKey)) {
            throw new Error('Context cleared');
          }
          if (isContextCancelled(contextKey)) {
            throw new Error('Context cancelled');
          }
          const currentState = await loadState(contextKey);
          const currentJob = currentState.activeJob ?? job;
          const nextJob = applyGenerationProgressToJob(currentJob, progress);
          await checkpoint(nextJob, contextKey);
        },
        onBatchHeartbeat: async (heartbeat) => {
          if (isContextCleared(contextKey) || isContextCancelled(contextKey)) {
            return;
          }
          const elapsedSec = Math.round(heartbeat.elapsedMs / 1000);
          const currentState = await loadState(contextKey);
          const currentJob = currentState.activeJob ?? job;
          const statusText = heartbeat.phase === 'backfill'
            ? `Backfilling coverage for untested endpoints — ${elapsedSec}s elapsed (${heartbeat.attempt})`
            : `Generating batch ${heartbeat.currentBatch + 1}/${heartbeat.totalBatches} — ${elapsedSec}s elapsed (${heartbeat.attempt})`;
          const beating: JobState = {
            ...currentJob,
            statusText,
            updatedAt: Date.now()
          };
          emitProgress(await replaceActiveJob(beating, contextKey), contextKey);
        }
      });
      const currentJob = (await loadState(contextKey)).activeJob ?? job;
      const existingDiagnostics = currentJob.batchDiagnostics ?? [];
      const mergedDiagnostics = [...existingDiagnostics];

      for (const diagnostic of generationResult.diagnostics) {
        if (!mergedDiagnostics.some((item) => item.batchIndex === diagnostic.batchIndex)) {
          mergedDiagnostics.push(diagnostic);
        }
      }

      finalTests = generationResult.tests;
      const costEstimateUsd = estimateCostUsd(
        currentJob.activeProvider ?? state.settings.provider,
        state.settings.model,
        generationResult.tokenUsage
      );
      finalJob = {
        ...currentJob,
        batchDiagnostics: mergedDiagnostics,
        qualityStatus: generationResult.finalAssessment.passed ? 'passed' : 'partial',
        tokenUsage: generationResult.tokenUsage,
        costEstimateUsd
      };
    }

    if (!state.settings.validateGeneratedTests || !state.settings.baseUrl || finalTests.length === 0) {
      return await finalizeGeneration(state, finalJob, finalTests, endpointsToGenerate.length, undefined, contextKey);
    }
    const remoteBlock = remoteTargetBlockReason(state.settings.baseUrl, state.settings);
    if (remoteBlock) {
      const blocked = buildSkippedSummary(finalTests, remoteBlock);
      return await finalizeGeneration(state, { ...finalJob, validationSummary: blocked }, finalTests, endpointsToGenerate.length, blocked, contextKey);
    }

    let validatedTests = finalTests;
    let validationSummary = await validateGeneratedTestsAgainstBaseUrl(
      state.settings,
      validatedTests,
      finalJob.endpoints,
      activeAbortController.signal
    );

    for (let round = 0; round < (state.settings.maxValidationRepairs ?? 0); round += 1) {
      // Only test-side failures are repairable; likely API bugs must stay failing.
      if (!state.settings.autoRepairFailingTests || !hasRepairableFailures(validationSummary)) {
        break;
      }

      const validatingJob: JobState = {
        ...finalJob,
        stage: 'validating',
        progress: 88 + Math.min(round * 3, 6),
        statusText: `Validating generated tests against ${state.settings.baseUrl} (${validationSummary.failed} failing)`,
        generatedTests: validatedTests,
        validationSummary,
        updatedAt: Date.now()
      };
      await checkpoint(validatingJob, contextKey);

      validatedTests = await repairTestsFromValidation({
        settings: state.settings,
        repo: finalJob.repo!,
        endpoints: finalJob.endpoints,
        tests: validatedTests,
        validationSummary,
        signal: activeAbortController.signal
      });

      validationSummary = await validateGeneratedTestsAgainstBaseUrl(
        state.settings,
        validatedTests,
        finalJob.endpoints,
        activeAbortController.signal
      );
      validationSummary = {
        ...validationSummary,
        repaired: round + 1
      };
    }

    const validatedJob: JobState = {
      ...finalJob,
      stage: 'validating',
      progress: 92,
      statusText: validationSummary.failed
        ? `Validation finished with ${validationSummary.failed} failing tests`
        : 'Validation passed against live API',
      generatedTests: validatedTests,
      validationSummary,
      updatedAt: Date.now()
    };
    await checkpoint(validatedJob, contextKey);

    return await finalizeGeneration(state, validatedJob, validatedTests, endpointsToGenerate.length, validationSummary, contextKey);
  } catch (error) {
    if (isContextCleared(contextKey)) {
      return await loadState(contextKey);
    }
    if (isContextCancelled(contextKey)) {
      cancelledContexts.delete(contextKey);
      return await loadState(contextKey);
    }
    const snapshot = (await loadState(contextKey)).activeJob ?? job;
    const qualitySnapshot = isBatchGenerationFailure(error)
      ? {
          ...snapshot,
          batchDiagnostics: [...(snapshot.batchDiagnostics ?? []), error.diagnostics],
          qualityStatus: 'failed' as const,
          repairAttempts: (snapshot.repairAttempts ?? 0) + (error.diagnostics.repairAttempted ? 1 : 0),
          statusText: error.diagnostics.assessment.issues[0]?.message ?? snapshot.statusText
        }
      : snapshot;
    return await completeWithError(qualitySnapshot, error, state.settings.framework, contextKey);
  } finally {
    await finishGenerationExecution(contextKey);
  }
};

const runScanPipeline = async (
  state: AppState,
  repo: RepoRef,
  contextId: string,
  options?: { resumeFromJob?: JobState; signal?: AbortSignal }
): Promise<AppState> => {
  const contextKey = resolveContextId(contextId);
  cancelledContexts.delete(contextKey);
  clearedContexts.delete(contextKey);
  const scanAbortController = await beginScanExecution(contextKey);
  const scanSignal = options?.signal ?? scanAbortController.signal;

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

  await setActiveJob(scanningJob, contextKey);
  updateBadgeForJob(scanningJob);
  emitProgress(await getStateSnapshot(contextKey), contextKey);

  try {
    const files = await scanRepositoryFiles(repo, {
      githubToken: state.settings.githubToken,
      gitlabToken: state.settings.gitlabToken,
      signal: scanSignal
    });

    if (isContextCleared(contextKey) || scanSignal.aborted || isContextCancelled(contextKey)) {
      if (isContextCancelled(contextKey)) {
        cancelledContexts.delete(contextKey);
      }
      return await loadState(contextKey);
    }

    const withFallback = applyOpenApiFallback(files, state.settings.openApiFallbackSpec);

    const parsingJob: JobState = {
      ...scanningJob,
      stage: 'parsing',
      progress: 60,
      statusText: `Parsing ${withFallback.files.length} files for API routes`,
      updatedAt: Date.now()
    };

    await checkpoint(parsingJob, contextKey);

    // Consolidate auth to the repo's dominant scheme so one API doesn't get bearer on one
    // endpoint, cookie on another — a frequent per-endpoint mis-detection.
    const endpoints = consolidateAuth(parseApiMap(withFallback.files)).endpoints;
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

    if (isContextCleared(contextKey) || scanSignal.aborted || isContextCancelled(contextKey)) {
      if (isContextCancelled(contextKey)) {
        cancelledContexts.delete(contextKey);
      }
      return await loadState(contextKey);
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
      suggestedFramework: suggestFramework(endpoints),
      statusText: `Scan complete: ${endpoints.length} APIs (${existingTestEndpointIds.length} already tested${fallbackLabel})`,
      updatedAt: completedAt,
      timings: {
        ...parsingJob.timings,
        scanCompletedAt: completedAt
      }
    };

    const nextState = await replaceActiveJob(completedScan, contextKey);
    updateBadgeForJob(completedScan);
    emitProgress(nextState, contextKey);

    notify(
      'APItiser scan complete',
      `${eligibleEndpointCount} APIs queued for generation${withFallback.usedFallback ? ' (with OpenAPI fallback)' : ''}`
    );
    return nextState;
  } catch (error) {
    if (isContextCleared(contextKey)) {
      return await loadState(contextKey);
    }
    if (isContextCancelled(contextKey)) {
      cancelledContexts.delete(contextKey);
      return await loadState(contextKey);
    }
    return await completeWithError(scanningJob, error, state.settings.framework, contextKey);
  } finally {
    await finishScanExecution(contextKey);
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
  // After a job completes it moves to history and activeJob becomes null. Fall back to the
  // most recent job so re-generating works on the existing scan without forcing a rescan —
  // but only a cleanly-finished job, never a cancelled/errored one left in history.
  const baseJob = state.activeJob ?? (isRunnableHistoryJob(state.jobHistory[0]) ? state.jobHistory[0] : undefined);
  if (!baseJob?.repo || baseJob.endpoints.length === 0) {
    throw new Error('No scanned endpoints available. Run Scan Repo first.');
  }

  if (generationInFlightContexts.has(contextId)) {
    throw new Error('Generation is already in progress.');
  }

  const hasExplicitSelection = Array.isArray(command.payload?.selectedEndpointIds);
  const selectedEndpointIds = command.payload?.selectedEndpointIds ?? [];
  const selectedEndpointSet = hasExplicitSelection ? new Set(selectedEndpointIds) : null;
  const selectedEndpoints = hasExplicitSelection
    ? baseJob.endpoints.filter((endpoint) => selectedEndpointSet?.has(endpoint.id))
    : baseJob.endpoints;

  const existingCovered = new Set(baseJob.existingTestEndpointIds ?? []);
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
    ...baseJob,
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
      ...baseJob.timings,
      generationStartedAt: Date.now()
    }
  };

  await checkpoint(generating, contextId);
  return await executeGeneration(state, generating, endpointsToGenerate, 0, [], contextId);
};

/**
 * A history job is safe to re-use as a base (for re-generation or "run locally") only if it
 * ended cleanly. `completeJob` pushes EVERY terminal job to history — including cancelled and
 * errored ones — so the fallback must exclude those rather than silently resurrect them.
 */
const isRunnableHistoryJob = (job?: JobState): job is JobState =>
  Boolean(job && (job.stage === 'complete' || job.stage === 'idle'));

/** Live tests mutate data and send attack payloads: loopback only unless explicitly allowed. */
const remoteTargetBlockReason = (baseUrl: string, settings: ExtensionSettings): string | undefined =>
  isLoopbackUrl(baseUrl) || settings.allowRemoteLiveTests
    ? undefined
    : `Live tests were not run against ${baseUrl}: it is not a local address, and these tests send ` +
      'POST/PUT/DELETE and attack-style requests. Use the local service, or enable ' +
      '"Allow live tests against non-local URLs" in Settings if this is a disposable environment.';

const serviceHoldKey = 'localservice';
// Original job per context while an on-demand run is in flight, so Cancel can restore it
// instead of marking the whole generated suite cancelled.
const endpointRunJobs = new Map<string, JobState>();

const publishServiceState = (contextId: string) => async (service: LocalServiceState): Promise<void> => {
  if (service.status === 'stopped' || service.status === 'error') {
    await releaseKeepAlive(serviceHoldKey);
  }
  emitStateSnapshot(await setLocalService(service, contextId), contextId);
};

/**
 * Everything the host needs to boot the repo on this page: the repo identity (so it can find the
 * user's clone or clone it), the user's per-repo folder if they chose one, where to clone/search,
 * and where the scanned API lives. Shared by Start and Run Locally so both pick the same folder.
 */
const bootOptionsFor = (state: AppState, pageRepo?: RepoRef) => {
  const job = state.activeJob ?? state.jobHistory[0];
  const repo = pageRepo ?? job?.repo;
  const target = repo ? bootRepoFor(repo, state.settings.gitlabBaseUrl) : undefined;
  // Legacy single "local repo path" still applies; the host ignores it for any other repo.
  const repoPath = (target && state.settings.repoPaths?.[target.slug]) || state.settings.localRepoPath?.trim() || undefined;
  if (!target && !repoPath) {
    throw new Error('Open a GitHub or GitLab repository page, then press Start.');
  }
  const scannedSameRepo = Boolean(job?.repo && repo && job.repo.owner === repo.owner && job.repo.repo === repo.repo);
  return {
    hostName: state.settings.localRunnerHostName,
    repoPath,
    repo: target,
    token: repo?.platform === 'gitlab' ? state.settings.gitlabToken : state.settings.githubToken,
    appDirHint: scannedSameRepo && job ? apiDirHint(job.endpoints) : undefined,
    cloneRoot: state.settings.cloneRoot?.trim() || undefined,
    searchRoots: state.settings.cloneSearchRoots?.filter(Boolean),
    port: state.settings.localRunPort ?? 0,
    runLocalScriptPath: state.settings.runLocalScriptPath,
    cmd: state.settings.localRunCmd,
    stack: state.settings.localRunStack,
    // Cloning + a first dependency install (e.g. a Python ML stack) routinely exceeds the old
    // 3-minute default; honour a longer setting, never a shorter one.
    bootTimeoutMs: Math.max(state.settings.localRunBootTimeoutMs ?? 0, 900_000)
  };
};

/**
 * One-click Start: no settings needed. The host finds the user's clone of the repo on this page
 * (or clones it), boots the API folder the scan found, its databases, and the frontend.
 */
const handleStartLocalService = async (contextId: string, pageRepo?: RepoRef): Promise<AppState> => {
  const state = await loadState(contextId);
  const options = bootOptionsFor(state, pageRepo);
  // Held for the service's lifetime; publishServiceState releases it on stop/error.
  await acquireKeepAlive(serviceHoldKey);
  await startLocalService(getPlatform().native, options, publishServiceState(contextId));
  return await loadState(contextId);
};

/** Rebuild the downloadable suite after tests changed post-generation (e.g. an accepted fix). */
const repackage = async (contextId: string): Promise<AppState> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job?.repo || !job.generatedTests.length) return state;
  const readinessAssessment = assessReadiness(job.generatedTests, job.validationSummary);
  const meta = { readiness: readinessAssessment.readiness, readinessNotes: readinessAssessment.notes, validationSummary: job.validationSummary };
  const files = renderGeneratedFiles(state.settings, job.repo, job.eligibleEndpointCount ?? job.endpoints.length, job.generatedTests, meta);
  const artifact = await buildArtifactZip(state.settings.framework, files, meta);
  await addArtifact(artifact, contextId);
  return await checkpoint({ ...job, artifactId: artifact.id, readiness: meta.readiness, readinessNotes: meta.readinessNotes, updatedAt: Date.now() }, contextId);
};

const handleProposeTestFix = async (contextId: string, endpointId: string, title: string): Promise<EventMessage> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job) throw new Error('Scan and generate tests first.');
  const proposal = await proposeTestFix({ settings: state.settings, job, endpointId, title });
  return { type: 'TEST_FIX_PROPOSAL', payload: proposal, contextId } as EventMessage;
};

/** The user accepted a reviewed test fix: apply it, re-run that endpoint, rebuild the download. */
const handleApplyTestFix = async (contextId: string, endpointId: string, title: string, test: JobState['generatedTests'][number]): Promise<AppState> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job || !isRunnableHistoryJob(job) || job.endpointRun) throw new Error('Wait for the current run to finish.');
  await checkpoint({ ...applyTestFix(job, endpointId, title, test), statusText: `Fixed “${test.title}”`, updatedAt: Date.now() }, contextId);
  try {
    await handleRunEndpointTests(contextId, [endpointId]);
  } catch (error) {
    // No running API to check against — keep the fix; the user can run it later.
    const current = (await loadState(contextId)).activeJob;
    if (current) await checkpoint({ ...current, statusText: `Fix applied — run it to check (${error instanceof Error ? error.message : 'no target'})` }, contextId);
  }
  return await repackage(contextId);
};

/** The repo folder on disk for code fixes: the chosen one, else where the last Start ran it. */
const codeRootFor = (state: AppState, job: JobState): string => {
  const slug = job.repo ? bootRepoFor(job.repo, state.settings.gitlabBaseUrl).slug : undefined;
  const root = (slug && state.settings.repoPaths?.[slug]) || (state.localService?.repoSlug === slug ? state.localService?.source?.path : undefined);
  if (!root) throw new Error('Press Start once so APItiser knows where this repo’s code is (or choose its folder under Run in Browser).');
  return root;
};

const handleProposeCodeFix = async (contextId: string, endpointId: string, title: string): Promise<EventMessage> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job) throw new Error('Scan and generate tests first.');
  const hostName = state.settings.localRunnerHostName;
  const proposal = await proposeCodeFix({
    settings: state.settings,
    job,
    endpointId,
    title,
    root: codeRootFor(state, job),
    readFiles: async (root, paths) =>
      (await hostRequest(getPlatform().native, { type: 'readFiles', root, paths }, 'files', { hostName })).files
  });
  return { type: 'CODE_FIX_PROPOSAL', payload: proposal, contextId } as EventMessage;
};

/**
 * After code changes: restart the API Start launched (so the change actually loads), then
 * re-run that endpoint's tests to show whether the fix worked.
 */
const restartAndRerun = async (contextId: string, endpointId: string, label: string): Promise<AppState> => {
  const managed = Boolean(getRunningService());
  if (managed) {
    const current = (await loadState(contextId)).activeJob;
    if (current) await checkpoint({ ...current, statusText: `${label} — restarting the API to load it…` }, contextId);
    await stopLocalService(publishServiceState(contextId));
    await handleStartLocalService(contextId);
  }
  try {
    await handleRunEndpointTests(contextId, [endpointId]);
  } catch (error) {
    const current = (await loadState(contextId)).activeJob;
    const hint = managed ? '' : ' If your API does not reload on file changes, restart it and run again.';
    if (current) await checkpoint({ ...current, statusText: `${label} — couldn't re-run (${error instanceof Error ? error.message : 'error'}).${hint}` }, contextId);
  }
  return await loadState(contextId);
};

/** The user approved the diffs: write them (host backs up originals), restart, re-run. */
const handleApplyCodeFix = async (contextId: string, proposal: CodeFixProposal): Promise<AppState> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job || !isRunnableHistoryJob(job) || job.endpointRun) throw new Error('Wait for the current run to finish.');
  const applied = await hostRequest(
    getPlatform().native,
    { type: 'applyEdits', root: proposal.root, edits: proposal.edits, allowedPaths: proposal.files },
    'editsApplied',
    { hostName: state.settings.localRunnerHostName }
  );
  await checkpoint({
    ...job,
    codeFix: { backupId: applied.backupId, root: proposal.root, files: applied.files, endpointId: proposal.endpointId, title: proposal.title, explanation: proposal.explanation, appliedAt: Date.now() },
    statusText: `Code fix applied to ${applied.files.join(', ')}`,
    updatedAt: Date.now()
  }, contextId);
  return await restartAndRerun(contextId, proposal.endpointId, 'Code fix applied');
};

const handleUndoCodeFix = async (contextId: string): Promise<AppState> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job?.codeFix) throw new Error('There is no code fix to undo.');
  if (job.endpointRun) throw new Error('Wait for the current run to finish.');
  await hostRequest(getPlatform().native, { type: 'restoreBackup', backupId: job.codeFix.backupId }, 'restored', { hostName: state.settings.localRunnerHostName });
  const { endpointId } = job.codeFix;
  await checkpoint({ ...job, codeFix: undefined, statusText: 'Code fix undone — original files restored', updatedAt: Date.now() }, contextId);
  return await restartAndRerun(contextId, endpointId, 'Code fix undone');
};

const handlePickFolder = async (prompt: string | undefined, contextId: string): Promise<EventMessage> => {
  const state = await loadState(contextId);
  const picked = await pickFolder(getPlatform().native, { hostName: state.settings.localRunnerHostName, prompt });
  return { type: 'FOLDER_PICKED', payload: picked, contextId } as EventMessage;
};

const handleStopLocalService = async (contextId: string): Promise<AppState> => {
  await stopLocalService(publishServiceState(contextId));
  return await loadState(contextId);
};

const API_CRASHED =
  'The API crashed during this run — one of these requests made its process exit. An unhandled error is a bug in the API: check its log, fix it, then press Start again.';

/**
 * Requests fail within ms of a crash, but the host's "process exited" notice can land a moment
 * later. When nothing answered at all, give it up to 2s before concluding it was never there.
 */
const serviceExitedDuringRun = async (summary: ValidationSummary): Promise<boolean> => {
  const deadline = Date.now() + (summary.notRunReason ? 2000 : 0);
  for (;;) {
    if (!getRunningService()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const withCrashNote = (summary: ValidationSummary): ValidationSummary =>
  summary.notRunReason
    ? { ...summary, notRunReason: API_CRASHED }
    : { ...summary, warnings: [API_CRASHED, ...(summary.warnings ?? [])] };

/**
 * Run the generated tests for the given endpoints (all when none given) against the running
 * local service (or the configured Base URL), streaming each result into the job as it lands.
 */
const handleRunEndpointTests = async (contextId: string, endpointIds?: string[]): Promise<AppState> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? state.jobHistory[0];
  if (!job?.generatedTests?.length) {
    throw new Error('Generate tests first, then run them.');
  }
  if (!isRunnableHistoryJob(job) || job.endpointRun || localRunAbortControllers.has(contextId)) {
    throw new Error('Wait for the current job or run to finish.');
  }
  const tests = selectTestsForEndpoints(job.generatedTests, endpointIds);
  if (!tests.length) {
    throw new Error('No generated tests for this endpoint yet — generate tests for it first.');
  }
  const target = getRunningService()?.baseUrl ?? state.settings.baseUrl?.trim();
  if (!target) {
    throw new Error('Start the local service, or set a Base URL in Settings, before running tests.');
  }
  const blocked = remoteTargetBlockReason(target, state.settings);
  if (blocked) {
    throw new Error(blocked);
  }

  const controller = new AbortController();
  localRunAbortControllers.set(contextId, controller);
  endpointRunJobs.set(contextId, job);
  cancelledContexts.delete(contextId);
  const holdKey = `endpointrun:${contextId}`;
  await acquireKeepAlive(holdKey);

  const endpoint = endpointIds?.length === 1 ? job.endpoints.find((item) => item.id === endpointIds[0]) : undefined;
  const label = endpoint ? `${endpoint.method} ${endpoint.path}` : `${tests.length} tests`;
  const endpointRun = { endpointIds: endpointIds ?? [], total: tests.length, startedAt: Date.now() };
  const streamed: ValidationResult[] = [];

  // Coalesced, serialized progress writes: at most one queued, and none after the run ends.
  let runActive = true;
  let queued = false;
  let chain: Promise<unknown> = Promise.resolve();
  const pushProgress = (): void => {
    if (queued) return;
    queued = true;
    chain = chain
      .then(async () => {
        queued = false;
        if (!runActive || controller.signal.aborted) return;
        await checkpoint({
          ...job,
          endpointRun,
          statusText: `Running ${label} against ${target} — ${streamed.length}/${tests.length}`,
          validationSummary: liveSummary(job.validationSummary, streamed, tests, target),
          updatedAt: Date.now()
        }, contextId);
      })
      .catch(() => undefined);
  };

  // If the API Start launched dies mid-run, connection failures mean "it crashed", not
  // "it was never there" — the latter message would send the user hunting for the wrong cause.
  const startedManaged = Boolean(getRunningService());
  try {
    pushProgress();
    const ranSummary = await validateGeneratedTestsAgainstBaseUrl(
      { ...state.settings, baseUrl: target },
      tests,
      job.endpoints,
      controller.signal,
      (result) => {
        streamed.push(result);
        pushProgress();
      }
    );
    runActive = false;
    await chain;
    if (controller.signal.aborted || isContextCancelled(contextId)) {
      return await loadState(contextId);
    }
    const summary = startedManaged && (await serviceExitedDuringRun(ranSummary)) ? withCrashNote(ranSummary) : ranSummary;
    return await checkpoint({
      ...job,
      endpointRun: undefined,
      statusText: summary.notRunReason ?? `${label}: ${summary.passed}/${summary.attempted} passed`,
      validationSummary: mergeValidationSummary(job.validationSummary, summary, tests),
      updatedAt: Date.now()
    }, contextId);
  } catch (error) {
    runActive = false;
    await chain;
    if (!controller.signal.aborted && !isContextCancelled(contextId)) {
      await checkpoint({ ...job, endpointRun: undefined, statusText: `Run failed: ${error instanceof Error ? error.message : 'unknown error'}`, updatedAt: Date.now() }, contextId);
    }
    throw error;
  } finally {
    runActive = false;
    endpointRunJobs.delete(contextId);
    localRunAbortControllers.delete(contextId);
    await releaseKeepAlive(holdKey);
  }
};

/**
 * Boot the configured repo's service via the native host (runLocal), validate the already
 * generated suite against http://localhost:<port>, finalize with the live results, then tear
 * the service down. This is the "generate → run" loop without the dev starting anything by hand.
 */
const handleRunLocally = async (contextId: string): Promise<AppState> => {
  const state = await loadState(contextId);
  // Generation completes by moving the job to history (activeJob → null); fall back to the
  // most recent job so "Run Locally" works on the just-generated suite without a rescan — but
  // only a job that actually finished cleanly (never a cancelled/errored one from history).
  const job = state.activeJob ?? (isRunnableHistoryJob(state.jobHistory[0]) ? state.jobHistory[0] : undefined);
  if (!job || !(job.generatedTests?.length)) {
    throw new Error('Generate tests first, then run them locally.');
  }
  if (!state.settings.enableLocalRunner) {
    throw new Error('Local runner is disabled. Enable it in Settings and install the native host (native-host/INSTALL.md).');
  }
  // Same folder resolution as Start (per-repo folder → found clone → clone).
  const bootOptions = bootOptionsFor(state);
  if (localRunAbortControllers.has(contextId)) {
    throw new Error('A local run is already in progress.');
  }

  const controller = new AbortController();
  localRunAbortControllers.set(contextId, controller);
  cancelledContexts.delete(contextId);

  // Status writes are fire-and-forget but SERIALIZED on a chain, and gated by `runActive`, so a
  // late throttled log update can never land after the run finalizes (which would revert the
  // completed job back to a stale "validating" state).
  let runActive = true;
  let statusChain: Promise<unknown> = Promise.resolve();
  const pushStatus = (statusText: string): void => {
    statusChain = statusChain.then(() =>
      runActive
        ? checkpoint({ ...job, stage: 'validating', statusText, updatedAt: Date.now() }, contextId).catch(() => undefined)
        : undefined
    );
  };

  // Booting + installing deps can take minutes; without a keep-alive the MV3 service worker is
  // suspended mid-wait and the UI freezes with no result. Hold it open for the whole run.
  const holdKey = `runlocal:${contextId}`;
  await acquireKeepAlive(holdKey);

  pushStatus('Starting local service via runLocal…');
  let lastLogAt = 0;

  let handle: Awaited<ReturnType<typeof bootRepoService>> | null = null;
  // A service started from the panel stays up: reuse it rather than booting a second copy on
  // the same port, and leave it running afterwards.
  const sessionHandle = getRunningService();
  try {
    handle = sessionHandle ?? await bootRepoService(getPlatform().native, {
      ...bootOptions,
      withFrontend: false, // a one-shot suite run only needs the API
      onStatus: (phase, message) => pushStatus(`Local runner: ${message ?? phase}`),
      // Surface runLocal's own output (install progress, errors) so a long boot shows life
      // instead of a frozen status. Throttled to avoid a storage write per log line.
      onLog: (line) => {
        const now = Date.now();
        if (now - lastLogAt > 1500) {
          lastLogAt = now;
          pushStatus(`runLocal: ${line.slice(0, 100)}`);
        }
      }
    });

    if (controller.signal.aborted || isContextCancelled(contextId)) {
      return await loadState(contextId);
    }

    // Boot is up — now run the GENERATED suite via its own framework runner against the live
    // service (no in-extension HTTP firing, no auth settings). The suite's env (API_BASE_URL,
    // and any tokens the user exports) handles credentials, not the extension.
    pushStatus(`Service ready on ${handle.baseUrl} — running the generated suite…`);
    const files = renderGeneratedFiles(state.settings, job.repo!, job.endpoints.length, job.generatedTests)
      .map((file) => ({ path: file.path, content: file.content }));
    const cmds = suiteCommandsFor(state.settings.framework);
    const result = await runGeneratedSuite(getPlatform().native, {
      hostName: state.settings.localRunnerHostName,
      files,
      installCmd: cmds.install,
      testCmd: cmds.test,
      port: handle.port, // the ACTUAL booted port (host may auto-detect e.g. 8000 from compose)
      timeoutMs: state.settings.localRunBootTimeoutMs,
      onStatus: (_phase, message) => pushStatus(`Suite: ${message ?? 'running'}`),
      onLog: (line) => {
        const now = Date.now();
        if (now - lastLogAt > 1500) {
          lastLogAt = now;
          pushStatus(`suite: ${line.slice(0, 100)}`);
        }
      }
    });

    runActive = false;
    await statusChain;
    if (controller.signal.aborted || isContextCancelled(contextId)) {
      return await loadState(contextId);
    }

    const ranJob: JobState = {
      ...job,
      stage: job.stage === 'complete' ? 'complete' : 'idle',
      statusText: result.passed
        ? `Generated suite passed (${result.command ?? state.settings.framework})`
        : `Generated suite: exit ${result.exitCode} (${result.command ?? state.settings.framework})`,
      localTestRun: { kind: 'generated', ...result, ranAt: Date.now() },
      updatedAt: Date.now()
    };
    return await checkpoint(ranJob, contextId);
  } catch (error) {
    if (controller.signal.aborted || isContextCancelled(contextId)) {
      return await loadState(contextId);
    }
    throw error;
  } finally {
    runActive = false;
    if (handle !== sessionHandle) {
      handle?.stop();
    }
    await releaseKeepAlive(holdKey);
    localRunAbortControllers.delete(contextId);
  }
};

/**
 * Run the repo's OWN existing test suite locally (pytest/npm test/go test/…) via the native
 * host and record the pass/fail result on the job. Independent of the generated suite — this
 * just exercises the tests already in the repo.
 */
const handleRunRepoTests = async (contextId: string): Promise<AppState> => {
  const state = await loadState(contextId);
  const job = state.activeJob ?? (isRunnableHistoryJob(state.jobHistory[0]) ? state.jobHistory[0] : undefined);
  if (!job) {
    throw new Error('Scan a repo first.');
  }
  if (!state.settings.enableLocalRunner) {
    throw new Error('Local runner is disabled. Enable it in Settings and install the native host.');
  }
  // The repo's own tests run in its folder: the one chosen for this repo, else the one the
  // last Start used for it (the host found or cloned it), else the legacy global path.
  const target = job.repo ? bootRepoFor(job.repo, state.settings.gitlabBaseUrl) : undefined;
  const lastStart = state.localService?.repoSlug === target?.slug ? state.localService?.source?.path : undefined;
  const repoPath = (target && state.settings.repoPaths?.[target.slug]) || lastStart || state.settings.localRepoPath?.trim();
  if (!repoPath) {
    throw new Error("APItiser doesn't know where this repo's code is yet — press Start once (it finds or clones it), or choose the folder under Run in Browser.");
  }
  if (localRunAbortControllers.has(contextId)) {
    throw new Error('A local run is already in progress.');
  }

  const controller = new AbortController();
  localRunAbortControllers.set(contextId, controller);
  cancelledContexts.delete(contextId);
  const holdKey = `runlocal:${contextId}`;
  await acquireKeepAlive(holdKey);

  let runActive = true;
  let statusChain: Promise<unknown> = Promise.resolve();
  let lastLogAt = 0;
  const pushStatus = (statusText: string): void => {
    statusChain = statusChain.then(() =>
      runActive ? checkpoint({ ...job, stage: 'validating', statusText, updatedAt: Date.now() }, contextId).catch(() => undefined) : undefined
    );
  };
  pushStatus('Running the repo\'s existing tests…');

  try {
    const result = await runRepoTests(getPlatform().native, {
      hostName: state.settings.localRunnerHostName,
      repoPath,
      testCmd: state.settings.localTestCommand,
      // Exported to the tests as API_BASE_URL: prefer the service actually running.
      port: getRunningService()?.port ?? (state.settings.localRunPort || undefined),
      timeoutMs: state.settings.localRunBootTimeoutMs,
      onStatus: (_phase, message) => pushStatus(`Repo tests: ${message ?? 'running'}`),
      onLog: (line) => {
        const now = Date.now();
        if (now - lastLogAt > 1500) {
          lastLogAt = now;
          pushStatus(`tests: ${line.slice(0, 100)}`);
        }
      }
    });

    runActive = false;
    await statusChain;
    if (controller.signal.aborted || isContextCancelled(contextId)) {
      return await loadState(contextId);
    }

    const updatedJob: JobState = {
      ...job,
      stage: job.stage === 'complete' ? 'complete' : 'idle',
      statusText: result.passed
        ? `Repo tests passed (${result.command ?? 'test suite'})`
        : `Repo tests failed — exit ${result.exitCode} (${result.command ?? 'test suite'})`,
      localTestRun: { kind: 'repo', ...result, ranAt: Date.now() },
      updatedAt: Date.now()
    };
    return await checkpoint(updatedJob, contextId);
  } catch (error) {
    if (controller.signal.aborted || isContextCancelled(contextId)) {
      return await loadState(contextId);
    }
    throw error;
  } finally {
    runActive = false;
    await releaseKeepAlive(holdKey);
    localRunAbortControllers.delete(contextId);
  }
};

const handleCancel = async (contextId: string): Promise<AppState> => {
  const state = await loadState(contextId);
  if (!state.activeJob) {
    return state;
  }

  const runJob = endpointRunJobs.get(contextId);
  if (runJob) {
    cancelledContexts.add(contextId);
    localRunAbortControllers.get(contextId)?.abort();
    endpointRunJobs.delete(contextId);
    return await checkpoint({ ...runJob, endpointRun: undefined, statusText: 'Run cancelled', updatedAt: Date.now() }, contextId);
  }

  cancelledContexts.add(contextId);
  generationAbortControllers.get(contextId)?.abort();
  scanAbortControllers.get(contextId)?.abort();
  localRunAbortControllers.get(contextId)?.abort();
  await finishGenerationExecution(contextId);
  await finishScanExecution(contextId);
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

const handleCheckLocalRunner = async (contextId: string): Promise<EventMessage> => {
  const state = await loadState(contextId);
  const host = await pingHost(getPlatform().native, { hostName: state.settings.localRunnerHostName });

  const port = state.settings.localRunPort ?? 0;
  let serviceOk = false;
  let serviceMessage = port
    ? `Nothing is listening on http://localhost:${port} yet — Start will launch it.`
    : 'Start picks a free port for the service.';
  try {
    if (!port) throw new Error('auto port — nothing to probe');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://localhost:${port}/`, { signal: controller.signal });
    clearTimeout(timer);
    serviceOk = true;
    serviceMessage = `A service is already responding on :${port} (HTTP ${res.status}).`;
  } catch {
    // Connection refused / timeout → nothing there yet, which is normal pre-run.
  }

  return {
    type: 'LOCAL_RUNNER_STATUS',
    payload: { hostOk: host.ok, hostMessage: host.message, serviceOk, serviceMessage },
    contextId
  } as EventMessage;
};

/**
 * Cheap liveness/auth check for a provider API key: hits each provider's list-models
 * endpoint (a GET that bills nothing) and maps the HTTP status to a friendly ✓/✗. Used by
 * the Settings "Test key" button so users see a bad key immediately rather than at generation.
 */
const handleTestProviderKey = async (
  command: Extract<CommandMessage, { type: 'TEST_PROVIDER_KEY' }>,
  contextId: string
): Promise<EventMessage> => {
  const { provider, apiKey, baseUrl } = command.payload;
  // A local OpenAI-compatible server (Ollama, LM Studio) needs no key — test reachability instead.
  const key = apiKey.trim() || (provider === 'openai' && isLoopbackUrl(baseUrl ?? '') ? LOCAL_LLM_KEY : '');
  const result = (ok: boolean, message: string): EventMessage =>
    ({ type: 'PROVIDER_KEY_STATUS', payload: { ok, message }, contextId }) as EventMessage;

  if (!key) {
    return result(false, 'Enter an API key first.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const { url, headers } = modelListRequest(provider, key, baseUrl);
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.ok) {
      const models = parseModelList(provider, await res.json().catch(() => ({})), baseUrl);
      const found = models.length ? ` ${models.length} model${models.length === 1 ? '' : 's'} available.` : '';
      const message = key === LOCAL_LLM_KEY ? `Local model server is reachable.${found}` : `Key is valid — provider reachable.${found}`;
      return { type: 'PROVIDER_KEY_STATUS', payload: { ok: true, message, models }, contextId } as EventMessage;
    }
    if (res.status === 401 || res.status === 403) {
      return result(
        false,
        key === LOCAL_LLM_KEY
          ? `The local server refused the request (HTTP ${res.status}) — it may be configured to require an API key.`
          : `Key rejected (HTTP ${res.status}). Check the key and its permissions.`
      );
    }
    if (res.status === 429) {
      return result(true, 'Key is valid, but you are rate-limited right now (HTTP 429).');
    }
    return result(false, `Provider returned HTTP ${res.status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    return result(false, `Could not reach the provider: ${message}.`);
  } finally {
    clearTimeout(timer);
  }
};

const handleTestRepoToken = async (
  command: Extract<CommandMessage, { type: 'TEST_REPO_TOKEN' }>,
  contextId: string
): Promise<EventMessage> => {
  const { platform, token, baseUrl } = command.payload;
  const { ok, message } = await validateRepoToken(platform, token, baseUrl);
  return { type: 'REPO_TOKEN_STATUS', payload: { ok, message }, contextId } as EventMessage;
};

const handleTestAtlassianToken = async (
  command: Extract<CommandMessage, { type: 'TEST_ATLASSIAN_TOKEN' }>,
  contextId: string
): Promise<EventMessage> => {
  const { siteUrl, email, token } = command.payload;
  const result = (ok: boolean, message: string): EventMessage =>
    ({ type: 'ATLASSIAN_TOKEN_STATUS', payload: { ok, message }, contextId }) as EventMessage;
  const trimmedSiteUrl = siteUrl.trim().replace(/\/+$/, '');

  if (!trimmedSiteUrl || !email.trim() || !token.trim()) {
    return result(false, 'Enter your Jira Cloud site URL, Atlassian account email, and API token.');
  }

  let url: URL;
  try {
    url = new URL(trimmedSiteUrl);
  } catch {
    return result(false, 'Enter a valid Jira Cloud site URL, for example https://your-team.atlassian.net.');
  }

  if (url.protocol !== 'https:' || !url.hostname.endsWith('.atlassian.net')) {
    return result(false, 'Atlassian validation requires an HTTPS *.atlassian.net Jira Cloud site URL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const credentials = btoa(`${email.trim()}:${token.trim()}`);
    const response = await fetch(`${url.origin}/rest/api/3/myself`, {
      headers: { Accept: 'application/json', Authorization: `Basic ${credentials}` },
      signal: controller.signal
    });
    if (response.ok) {
      return result(true, 'Token is valid — Jira Cloud account reachable.');
    }
    if (response.status === 401 || response.status === 403) {
      return result(false, `Token rejected (HTTP ${response.status}). Check the account email, token, and site URL.`);
    }
    return result(false, `Jira Cloud returned HTTP ${response.status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    return result(false, `Could not reach Jira Cloud: ${message}.`);
  } finally {
    clearTimeout(timer);
  }
};

const handleDownloadRunner = async (contextId: string): Promise<EventMessage> => {
  const zipBase64 = await buildRunnerZipBase64();
  await chrome.downloads.download({
    filename: runnerZipFileName(),
    saveAs: true,
    url: `data:application/zip;base64,${zipBase64}`
  });
  return { type: 'ACK', contextId } as EventMessage;
};

const handleExportPostman = async (contextId: string): Promise<EventMessage> => {
  const state = await loadState(contextId);
  const repo = state.activeJob?.repo ?? state.jobHistory[0]?.repo;
  const tests = state.activeJob?.generatedTests ?? state.jobHistory[0]?.generatedTests ?? [];
  const endpoints = state.activeJob?.endpoints ?? state.jobHistory[0]?.endpoints ?? [];

  if (!repo || !tests.length || !endpoints.length) {
    throw new Error('No generated tests available to export');
  }

  const baseUrl = state.settings.baseUrl || 'http://localhost:3000';
  const collection = buildPostmanCollection(repo, tests, endpoints, baseUrl);
  const base64 = btoa(unescape(encodeURIComponent(collection)));

  await chrome.downloads.download({
    filename: `APItiser_${repo.repo}_Postman.json`,
    saveAs: true,
    url: `data:application/json;base64,${base64}`
  });

  return { type: 'ACK', contextId } as EventMessage;
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
  cancelledContexts.delete(contextId);
  generationAbortControllers.get(contextId)?.abort();
  scanAbortControllers.get(contextId)?.abort();
  await finishGenerationExecution(contextId);
  await finishScanExecution(contextId);
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
  const staleService = staleServiceState(Object.values(allStates)[0]?.localService);
  if (staleService) {
    await setLocalService(staleService);
  }
  const resumableStates = Object.values(allStates).filter((state) => Boolean(state.activeJob));
  if (!resumableStates.length) {
    return;
  }

  for (const state of resumableStates) {
    const contextId = state.contextId ?? 'global';
    const job = state.activeJob!;

    if (job.endpointRun) {
      await checkpoint({ ...job, endpointRun: undefined, statusText: 'Run interrupted — the extension restarted.', updatedAt: Date.now() }, contextId);
      continue;
    }

    if (job.stage === 'generating') {
      if (generationInFlightContexts.has(contextId)) {
        continue;
      }

      const queuedEndpoints = resolveQueuedEndpoints(job);
      const remaining = Math.max(queuedEndpoints.length - job.completedBatches * state.settings.batchSize, 0);

      if (remaining > 0) {
        const key = requiredProviderKey(state);
        if (!key) {
          await completeWithError(job, new Error('Cannot resume generation: missing provider API key.'), state.settings.framework, contextId);
          continue;
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
      continue;
    }

    if (job.stage === 'packaging') {
      if (generationInFlightContexts.has(contextId)) {
        continue;
      }

      const resumed: JobState = {
        ...job,
        resumedFromCheckpoint: true,
        statusText: 'Resuming packaging from checkpoint',
        updatedAt: Date.now()
      };
      await checkpoint(resumed, contextId);
      void (async () => {
        try {
          await beginGenerationExecution(contextId);
          await finalizeGeneration(state, resumed, resumed.generatedTests, resolveQueuedEndpoints(resumed).length, undefined, contextId);
        } catch (error) {
          if (isContextCleared(contextId)) {
            return;
          }
          if (isContextCancelled(contextId)) {
            cancelledContexts.delete(contextId);
            return;
          }
          await completeWithError(resumed, error, state.settings.framework, contextId);
        } finally {
          await finishGenerationExecution(contextId);
        }
      })();
      continue;
    }

    if (job.stage === 'scanning' || job.stage === 'parsing') {
      if (scanInFlightContexts.has(contextId)) {
        continue;
      }
      if (!job.repo) {
        await completeWithError(job, new Error('Scan checkpoint is missing repository context.'), state.settings.framework, contextId);
        continue;
      }
      void runScanPipeline(state, job.repo, contextId, { resumeFromJob: job });
    }
  }
};

const handleMessage = (message: CommandMessage, _sender: unknown, sendResponse: (response: EventMessage) => void): boolean => {
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

      if (message.type === 'EXPORT_POSTMAN') {
        sendResponse(await handleExportPostman(contextId));
        return;
      }

      if (message.type === 'RUN_LOCALLY') {
        const next = await handleRunLocally(contextId);
        sendResponse({ type: 'JOB_COMPLETE', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'RUN_REPO_TESTS') {
        const next = await handleRunRepoTests(contextId);
        sendResponse({ type: 'JOB_COMPLETE', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'START_LOCAL_SERVICE') {
        const next = await handleStartLocalService(contextId, message.payload?.repo);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'STOP_LOCAL_SERVICE') {
        const next = await handleStopLocalService(contextId);
        sendResponse({ type: 'STATE_SNAPSHOT', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'PROPOSE_TEST_FIX') {
        sendResponse(await handleProposeTestFix(contextId, message.payload.endpointId, message.payload.title));
        return;
      }

      if (message.type === 'APPLY_TEST_FIX') {
        const next = await handleApplyTestFix(contextId, message.payload.endpointId, message.payload.title, message.payload.test);
        sendResponse({ type: 'JOB_COMPLETE', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'PROPOSE_CODE_FIX') {
        sendResponse(await handleProposeCodeFix(contextId, message.payload.endpointId, message.payload.title));
        return;
      }

      if (message.type === 'APPLY_CODE_FIX') {
        const next = await handleApplyCodeFix(contextId, message.payload.proposal);
        sendResponse({ type: 'JOB_COMPLETE', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'UNDO_CODE_FIX') {
        const next = await handleUndoCodeFix(contextId);
        sendResponse({ type: 'JOB_COMPLETE', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'PICK_FOLDER') {
        sendResponse(await handlePickFolder(message.payload?.prompt, contextId));
        return;
      }

      if (message.type === 'RUN_ENDPOINT_TESTS') {
        const next = await handleRunEndpointTests(contextId, message.payload?.endpointIds);
        sendResponse({ type: 'JOB_COMPLETE', payload: next, contextId } as EventMessage);
        return;
      }

      if (message.type === 'DOWNLOAD_RUNNER') {
        sendResponse(await handleDownloadRunner(contextId));
        return;
      }

      if (message.type === 'CHECK_LOCAL_RUNNER') {
        sendResponse(await handleCheckLocalRunner(contextId));
        return;
      }

      if (message.type === 'TEST_PROVIDER_KEY') {
        sendResponse(await handleTestProviderKey(message, contextId));
        return;
      }

      if (message.type === 'TEST_REPO_TOKEN') {
        sendResponse(await handleTestRepoToken(message, contextId));
        return;
      }

      if (message.type === 'TEST_ATLASSIAN_TOKEN') {
        sendResponse(await handleTestAtlassianToken(message, contextId));
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
};

export const registerListeners = (): void => {
  chrome.runtime.onInstalled.addListener(async (details) => {
    const state = await loadState();
    await saveState(state);
    clearBadge();
    await configureSidePanelDefaults();
    // On a fresh install (not an update/chrome-restart), open the guided first-run wizard
    // in a full tab, unless the user has already completed onboarding on this profile.
    if (details.reason === 'install' && !state.settings.onboardingCompletedAt) {
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
      } catch (error) {
        console.warn('Onboarding tab open failed:', error);
      }
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    void configureSidePanelDefaults();
    void autoResumeActiveJob();
  });

  // Open the panel only in the tab whose toolbar icon was clicked. We do NOT enable the panel on
  // tab activation/update — doing so made it appear on every tab the user visited.
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) {
      openSidePanelForTab(tab.id);
    }
  });

  registerKeepAliveListener();
  chrome.runtime.onMessage.addListener(handleMessage);
};

export const bootstrap = (): void => {
  registerListeners();
  void configureSidePanelDefaults();
  void autoResumeActiveJob();
};

// Only auto-bootstrap in real service worker context (not in tests).
// Tests import the module to access `handleMessage`, `registerListeners`, or `bootstrap` directly.
if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test') {
  bootstrap();
}

export { handleMessage };
