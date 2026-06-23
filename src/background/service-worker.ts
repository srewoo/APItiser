/// <reference lib="webworker" />

import type { AppState, JobState, RepoRef, RunMetric } from '@shared/types';
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
import { validateRepoAccess } from './repo/validator';
import { buildCoverage } from './generation/coverage';
import { suggestFramework } from './generation/frameworkSuggest';
import { buildArtifactZip } from './generation/zipBuilder';
import { assessReadiness } from './generation/readiness';
import { assessGeneratedTestQuality } from './generation/qualityGate';
import { buildPostmanCollection } from './generation/postmanExport';
import { validateGeneratedTestsAgainstBaseUrl } from './generation/executionValidator';
import { bootRepoService, pingHost, runRepoTests, runGeneratedSuite } from './runner/localRunner';
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
      finalJob = {
        ...currentJob,
        batchDiagnostics: mergedDiagnostics,
        qualityStatus: generationResult.finalAssessment.passed ? 'passed' : 'partial'
      };
    }

    if (!state.settings.validateGeneratedTests || !state.settings.baseUrl || finalTests.length === 0) {
      return await finalizeGeneration(state, finalJob, finalTests, endpointsToGenerate.length, undefined, contextKey);
    }

    let validatedTests = finalTests;
    let validationSummary = await validateGeneratedTestsAgainstBaseUrl(
      state.settings,
      validatedTests,
      finalJob.endpoints,
      activeAbortController.signal
    );

    for (let round = 0; round < (state.settings.maxValidationRepairs ?? 0); round += 1) {
      if (!state.settings.autoRepairFailingTests || validationSummary.failed === 0) {
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
  const repoPath = state.settings.localRepoPath?.trim();
  if (!repoPath) {
    throw new Error('Set the local repo path in Settings before running locally.');
  }
  if (localRunAbortControllers.has(contextId)) {
    throw new Error('A local run is already in progress.');
  }

  const port = state.settings.localRunPort ?? 8080;
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
  try {
    handle = await bootRepoService(getPlatform().native, {
      hostName: state.settings.localRunnerHostName,
      repoPath,
      port,
      runLocalScriptPath: state.settings.runLocalScriptPath,
      cmd: state.settings.localRunCmd,
      stack: state.settings.localRunStack,
      bootTimeoutMs: state.settings.localRunBootTimeoutMs,
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
    handle?.stop();
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
  const repoPath = state.settings.localRepoPath?.trim();
  if (!repoPath) {
    throw new Error('Set the local repo path in Settings first.');
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
      port: state.settings.localRunPort ?? 8080,
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

  const port = state.settings.localRunPort ?? 8080;
  let serviceOk = false;
  let serviceMessage = `Nothing is listening on http://localhost:${port} yet — runLocal will start it.`;
  try {
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
  const resumableStates = Object.values(allStates).filter((state) => Boolean(state.activeJob));
  if (!resumableStates.length) {
    return;
  }

  for (const state of resumableStates) {
    const contextId = state.contextId ?? 'global';
    const job = state.activeJob!;

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

      if (message.type === 'DOWNLOAD_RUNNER') {
        sendResponse(await handleDownloadRunner(contextId));
        return;
      }

      if (message.type === 'CHECK_LOCAL_RUNNER') {
        sendResponse(await handleCheckLocalRunner(contextId));
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
