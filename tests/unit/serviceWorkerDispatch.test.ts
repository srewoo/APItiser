import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/chromeMock';
import { makeAppState, makeSettings } from '@shared/testing/factories';
import type { EventMessage } from '@shared/messages';

// ---------------------------------------------------------------------------
// Mock all service-worker downstream modules so module-level side effects
// (autoResumeActiveJob, configureSidePanelDefaults) don't trigger real I/O.
// ---------------------------------------------------------------------------

vi.mock('@background/core/stateManager', () => ({
  loadState: vi.fn(),
  loadAllStates: vi.fn().mockResolvedValue({}),
  saveState: vi.fn().mockResolvedValue(undefined),
  updateSettings: vi.fn(),
  setActiveJob: vi.fn().mockResolvedValue(undefined),
  replaceActiveJob: vi.fn(),
  completeJob: vi.fn(),
  setLastValidation: vi.fn(),
  clearContext: vi.fn(),
  getArtifactById: vi.fn()
}));

vi.mock('@background/core/emitter', () => ({
  emitProgress: vi.fn(),
  emitComplete: vi.fn(),
  emitError: vi.fn(),
  emitStateSnapshot: vi.fn()
}));

vi.mock('@background/core/badge', () => ({
  updateBadgeForJob: vi.fn(),
  clearBadge: vi.fn()
}));

vi.mock('@background/core/notifier', () => ({ notify: vi.fn() }));

vi.mock('@background/core/keepAlive', () => ({
  registerKeepAliveListener: vi.fn(),
  startKeepAlive: vi.fn().mockResolvedValue(undefined),
  stopKeepAlive: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@background/repo/scanner', () => ({ scanRepositoryFiles: vi.fn() }));
vi.mock('@background/repo/validator', () => ({ validateRepoAccess: vi.fn() }));
vi.mock('@background/parser/apiParser', () => ({ parseApiMap: vi.fn().mockReturnValue([]) }));
vi.mock('@background/parser/scanInput', () => ({ applyOpenApiFallback: vi.fn().mockReturnValue({ files: [], usedFallback: false }) }));
vi.mock('@background/parser/testCoverageDetector', () => ({ detectExistingTestCoverage: vi.fn().mockReturnValue([]) }));
vi.mock('@background/generation/testGenerator', () => ({
  generateTestSuite: vi.fn(),
  renderGeneratedFiles: vi.fn().mockReturnValue([]),
  repairTestsFromValidation: vi.fn(),
  applyGenerationProgressToJob: vi.fn()
}));
vi.mock('@background/generation/executionValidator', () => ({ validateGeneratedTestsAgainstBaseUrl: vi.fn() }));
vi.mock('@background/generation/zipBuilder', () => ({ buildArtifactZip: vi.fn() }));
vi.mock('@background/generation/readiness', () => ({ assessReadiness: vi.fn().mockReturnValue({ readiness: 'review_required', notes: [] }) }));
vi.mock('@background/generation/coverage', () => ({ buildCoverage: vi.fn().mockReturnValue({ coveragePercent: 0, testsGenerated: 0 }) }));
vi.mock('@background/generation/postmanExport', () => ({ buildPostmanCollection: vi.fn().mockReturnValue('{}') }));

describe('service-worker message dispatch', () => {
  let fake: FakeChrome;
  let onMessageHandler: (
    message: unknown,
    sender: unknown,
    sendResponse: (response: EventMessage) => void
  ) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    fake = installFakeChrome();

    const { loadState, loadAllStates, updateSettings, setLastValidation, clearContext, getArtifactById } =
      await import('@background/core/stateManager');
    const defaultState = makeAppState({ settings: makeSettings() });

    vi.mocked(loadState).mockResolvedValue(defaultState);
    vi.mocked(loadAllStates).mockResolvedValue({});
    vi.mocked(updateSettings).mockResolvedValue(defaultState);
    vi.mocked(setLastValidation).mockResolvedValue(defaultState);
    vi.mocked(clearContext).mockResolvedValue(defaultState);
    vi.mocked(getArtifactById).mockResolvedValue(undefined);

    // Import the service worker — auto-bootstrap is skipped in NODE_ENV=test
    const mod = await import('@background/service-worker');
    // Explicitly register listeners in the test (production calls bootstrap()).
    mod.registerListeners();

    // Extract the message listener registered by the service worker
    const calls = fake.runtime.onMessage.addListener.mock.calls as Array<[typeof onMessageHandler]>;
    onMessageHandler = calls[calls.length - 1][0];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // GET_STATE
  // -------------------------------------------------------------------------

  it('GET_STATE returns a STATE_SNAPSHOT with the loaded app state', async () => {
    const sendResponse = vi.fn<(response: EventMessage) => void>();

    const returned = onMessageHandler({ type: 'GET_STATE' }, {}, sendResponse);
    expect(returned).toBe(true); // must return true to keep the message channel open

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(sendResponse).toHaveBeenCalledOnce();
    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('STATE_SNAPSHOT');
  });

  // -------------------------------------------------------------------------
  // SAVE_SETTINGS
  // -------------------------------------------------------------------------

  it('SAVE_SETTINGS calls updateSettings and responds with SETTINGS_SAVED', async () => {
    const { updateSettings, loadState } = await import('@background/core/stateManager');
    const { emitStateSnapshot } = await import('@background/core/emitter');
    const newSettings = makeSettings({ framework: 'mocha' });
    const sendResponse = vi.fn<(response: EventMessage) => void>();

    onMessageHandler({ type: 'SAVE_SETTINGS', payload: newSettings }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(updateSettings).toHaveBeenCalledWith(newSettings, 'global');
    expect(emitStateSnapshot).toHaveBeenCalled();
    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('SETTINGS_SAVED');
  });

  // -------------------------------------------------------------------------
  // CANCEL_JOB — no active job
  // -------------------------------------------------------------------------

  it('CANCEL_JOB with no active job returns current STATE_SNAPSHOT', async () => {
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'CANCEL_JOB' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('STATE_SNAPSHOT');
  });

  // -------------------------------------------------------------------------
  // Unknown message type → ACK
  // -------------------------------------------------------------------------

  it('unknown message type responds with ACK', async () => {
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'UNKNOWN_MESSAGE_TYPE' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('ACK');
  });

  // -------------------------------------------------------------------------
  // DOWNLOAD_ARTIFACT — artifact not found
  // -------------------------------------------------------------------------

  it('DOWNLOAD_ARTIFACT with missing artifact responds with JOB_ERROR', async () => {
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'DOWNLOAD_ARTIFACT', payload: { artifactId: 'not-found' } }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('JOB_ERROR');
    expect((response as { error: string }).error).toContain('Artifact not found');
  });

  // -------------------------------------------------------------------------
  // contextId propagation
  // -------------------------------------------------------------------------

  it('passes contextId through to loadState', async () => {
    const { loadState } = await import('@background/core/stateManager');
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'GET_STATE', contextId: 'tab-42' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(loadState).toHaveBeenCalledWith('tab-42');
  });

  it('treats blank contextId as global', async () => {
    const { loadState } = await import('@background/core/stateManager');
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'GET_STATE', contextId: '  ' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(loadState).toHaveBeenCalledWith('global');
  });
});
