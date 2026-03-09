import { DEFAULT_SETTINGS, STORAGE_KEY } from '@shared/constants';
import type {
  AppState,
  ExtensionSettings,
  GeneratedArtifact,
  JobState,
  RepoValidationResult,
  RunMetric
} from '@shared/types';

const maxHistory = 20;
const maxArtifacts = 10;
const maxMetrics = 100;
const defaultContextId = 'global';

interface ContextState {
  activeJob: JobState | null;
  jobHistory: JobState[];
  artifacts: GeneratedArtifact[];
  metricsHistory: RunMetric[];
  lastValidation?: RepoValidationResult;
}

interface StoredStateV2 {
  settings: ExtensionSettings;
  contexts: Record<string, ContextState>;
}

const resolveContextId = (contextId?: string): string => {
  const normalized = contextId?.trim();
  return normalized || defaultContextId;
};

const defaultContextState = (): ContextState => ({
  activeJob: null,
  jobHistory: [],
  artifacts: [],
  metricsHistory: []
});

const sanitizeContextState = (input?: Partial<ContextState>): ContextState => ({
  activeJob: input?.activeJob ?? null,
  jobHistory: input?.jobHistory ?? [],
  artifacts: input?.artifacts ?? [],
  metricsHistory: input?.metricsHistory ?? [],
  lastValidation: input?.lastValidation
});

const defaultStore = (): StoredStateV2 => ({
  settings: { ...DEFAULT_SETTINGS },
  contexts: {
    [defaultContextId]: defaultContextState()
  }
});

const toAppState = (store: StoredStateV2, contextId: string): AppState => {
  const context = store.contexts[contextId] ?? defaultContextState();
  return {
    contextId,
    settings: { ...DEFAULT_SETTINGS, ...store.settings },
    activeJob: context.activeJob,
    jobHistory: context.jobHistory,
    artifacts: context.artifacts,
    metricsHistory: context.metricsHistory,
    lastValidation: context.lastValidation
  };
};

const normalizeStore = (persisted: unknown): StoredStateV2 => {
  if (!persisted || typeof persisted !== 'object') {
    return defaultStore();
  }

  const value = persisted as Partial<StoredStateV2> & Partial<AppState>;

  if (value.contexts && typeof value.contexts === 'object') {
    const contexts: Record<string, ContextState> = {};
    for (const [key, contextValue] of Object.entries(value.contexts as Record<string, Partial<ContextState>>)) {
      contexts[key] = sanitizeContextState(contextValue);
    }

    if (!Object.keys(contexts).length) {
      contexts[defaultContextId] = defaultContextState();
    }

    return {
      settings: { ...DEFAULT_SETTINGS, ...(value.settings ?? {}) },
      contexts
    };
  }

  const migrated: StoredStateV2 = {
    settings: { ...DEFAULT_SETTINGS, ...(value.settings ?? {}) },
    contexts: {
      [defaultContextId]: sanitizeContextState({
        activeJob: value.activeJob ?? null,
        jobHistory: value.jobHistory ?? [],
        artifacts: value.artifacts ?? [],
        metricsHistory: value.metricsHistory ?? [],
        lastValidation: value.lastValidation
      })
    }
  };

  return migrated;
};

const loadStore = async (): Promise<StoredStateV2> => {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeStore(raw[STORAGE_KEY]);
};

const saveStore = async (store: StoredStateV2): Promise<void> => {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
};

const updateContext = (store: StoredStateV2, contextId: string, patch: Partial<ContextState>): void => {
  const current = store.contexts[contextId] ?? defaultContextState();
  store.contexts[contextId] = {
    ...current,
    ...patch
  };
};

export async function loadState(contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  return toAppState(store, resolved);
}

export async function loadAllStates(): Promise<Record<string, AppState>> {
  const store = await loadStore();
  const results: Record<string, AppState> = {};
  for (const contextId of Object.keys(store.contexts)) {
    results[contextId] = toAppState(store, contextId);
  }
  if (!results[defaultContextId]) {
    results[defaultContextId] = toAppState(store, defaultContextId);
  }
  return results;
}

export async function saveState(state: AppState): Promise<void> {
  const contextId = resolveContextId(state.contextId);
  const store = await loadStore();
  store.settings = { ...DEFAULT_SETTINGS, ...state.settings };
  updateContext(store, contextId, {
    activeJob: state.activeJob,
    jobHistory: state.jobHistory,
    artifacts: state.artifacts,
    metricsHistory: state.metricsHistory,
    lastValidation: state.lastValidation
  });
  await saveStore(store);
}

export async function updateSettings(patch: Partial<ExtensionSettings>, contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  const normalizedPatch: Partial<ExtensionSettings> = { ...patch };

  if (normalizedPatch.testDirectories) {
    normalizedPatch.testDirectories = normalizedPatch.testDirectories
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof normalizedPatch.openApiFallbackSpec === 'string') {
    normalizedPatch.openApiFallbackSpec = normalizedPatch.openApiFallbackSpec.trim();
  }

  store.settings = {
    ...store.settings,
    ...normalizedPatch
  };

  await saveStore(store);
  return toAppState(store, resolved);
}

export async function setActiveJob(job: JobState | null, contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  updateContext(store, resolved, { activeJob: job });
  await saveStore(store);
  return toAppState(store, resolved);
}

export async function completeJob(
  job: JobState,
  artifact?: GeneratedArtifact,
  metric?: RunMetric,
  contextId?: string
): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  const context = store.contexts[resolved] ?? defaultContextState();

  const nextContext: ContextState = {
    ...context,
    activeJob: null,
    jobHistory: [job, ...context.jobHistory].slice(0, maxHistory),
    artifacts: artifact ? [artifact, ...context.artifacts].slice(0, maxArtifacts) : context.artifacts,
    metricsHistory: metric ? [metric, ...context.metricsHistory].slice(0, maxMetrics) : context.metricsHistory
  };

  store.contexts[resolved] = nextContext;
  await saveStore(store);
  return toAppState(store, resolved);
}

export async function getArtifactById(artifactId: string, contextId?: string): Promise<GeneratedArtifact | undefined> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  const context = store.contexts[resolved] ?? defaultContextState();
  return context.artifacts.find((item) => item.id === artifactId);
}

export async function replaceActiveJob(job: JobState, contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  updateContext(store, resolved, { activeJob: job });
  await saveStore(store);
  return toAppState(store, resolved);
}

export async function setLastValidation(result: RepoValidationResult, contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  updateContext(store, resolved, { lastValidation: result });
  await saveStore(store);
  return toAppState(store, resolved);
}

export async function clearContext(contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  store.contexts[resolved] = defaultContextState();
  await saveStore(store);
  return toAppState(store, resolved);
}
