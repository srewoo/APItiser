import { DEFAULT_SETTINGS, STORAGE_KEY } from '@shared/constants';
import { getPlatform } from '@shared/platform';
import type {
  AppState,
  ExtensionSettings,
  GeneratedArtifact,
  JobState,
  LocalServiceState,
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
  /** Extension-wide: only one local service runs at a time (it owns a single port). */
  localService?: LocalServiceState;
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
    lastValidation: context.lastValidation,
    localService: store.localService
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
      contexts,
      localService: value.localService
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

// Ephemeral secrets. When a session store is available these live in memory-only
// `chrome.storage.session` (cleared on browser close, never persisted to disk) rather than in
// the on-disk local store. Provider/repo keys are intentionally NOT here — they must survive a
// browser restart, so they stay in local storage.
const SECRETS_KEY = 'apitiser.secrets.v1';
const EPHEMERAL_SECRET_KEYS = [
  'runtimeApiToken',
  'runtimeApiKey',
  'runtimeCsrfToken',
  'runtimeSessionCookie',
  'runtimeSecondaryApiToken',
  'runtimeSecondaryApiKey',
  'runtimeSecondarySessionCookie',
  'runtimeValues'
] as const satisfies ReadonlyArray<keyof ExtensionSettings>;

// The local service's status lives under its OWN key. Job writes read-modify-write the whole
// state object; sharing it meant a job write that raced a status change (e.g. "the API crashed")
// would write the stale status back. Separate keys make that lost update impossible.
const SERVICE_KEY = 'apitiser.localService.v1';

const loadStore = async (): Promise<StoredStateV2> => {
  const platform = getPlatform();
  const store = normalizeStore(await platform.storage.get(STORAGE_KEY));
  const service = (await platform.storage.get(SERVICE_KEY)) as LocalServiceState | undefined;
  store.localService = service ?? store.localService;
  if (platform.session) {
    const secrets = (await platform.session.get(SECRETS_KEY)) as Partial<ExtensionSettings> | undefined;
    if (secrets) {
      store.settings = { ...store.settings, ...secrets };
    }
  }
  return store;
};

const saveStore = async (input: StoredStateV2): Promise<void> => {
  const platform = getPlatform();
  // Never persist the service status with the state object (see SERVICE_KEY).
  const { localService: _service, ...store } = input;
  if (!platform.session) {
    await platform.storage.set(STORAGE_KEY, store);
    return;
  }
  // Separate the ephemeral secrets out to session storage; write the rest to disk. Clone so the
  // in-memory `store` (returned to callers) keeps the secrets — only the persisted copy drops them.
  const settingsForLocal: ExtensionSettings = { ...store.settings };
  const secrets: Partial<ExtensionSettings> = {};
  const localAsRecord = settingsForLocal as unknown as Record<string, unknown>;
  const secretsAsRecord = secrets as unknown as Record<string, unknown>;
  for (const key of EPHEMERAL_SECRET_KEYS) {
    if (localAsRecord[key] !== undefined) {
      secretsAsRecord[key] = localAsRecord[key];
      delete localAsRecord[key];
    }
  }
  await platform.storage.set(STORAGE_KEY, { ...store, settings: settingsForLocal });
  await platform.session.set(SECRETS_KEY, secrets);
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
  if (normalizedPatch.runtimeSetupSteps && Array.isArray(normalizedPatch.runtimeSetupSteps)) {
    normalizedPatch.runtimeSetupSteps = normalizedPatch.runtimeSetupSteps
      .filter((step): step is NonNullable<ExtensionSettings['runtimeSetupSteps']>[number] => Boolean(step && typeof step === 'object'))
      .map((step) => ({
        ...step,
        id: String(step.id ?? '').trim(),
        name: String(step.name ?? '').trim(),
        method: String(step.method ?? 'GET').toUpperCase(),
        path: String(step.path ?? '').trim()
      }))
      .filter((step) => Boolean(step.id && step.name && step.path));
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

/**
 * Record the local service's lifecycle. Written only here (never by saveState) so a stale
 * AppState snapshot can't clobber a newer service status.
 */
export async function setLocalService(service: LocalServiceState, contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  await getPlatform().storage.set(SERVICE_KEY, service);
  return toAppState(await loadStore(), resolved);
}

/** Make `artifact` the newest download for this context (after tests change post-generation). */
export async function addArtifact(artifact: GeneratedArtifact, contextId?: string): Promise<AppState> {
  const resolved = resolveContextId(contextId);
  const store = await loadStore();
  const context = store.contexts[resolved] ?? defaultContextState();
  updateContext(store, resolved, { artifacts: [artifact, ...context.artifacts].slice(0, maxArtifacts) });
  await saveStore(store);
  return toAppState(store, resolved);
}
