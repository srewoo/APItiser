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
vi.mock('@background/parser/scanInput', () => ({
  applyOpenApiFallback: vi.fn().mockReturnValue({ files: [], usedFallback: false })
}));
vi.mock('@background/parser/testCoverageDetector', () => ({ detectExistingTestCoverage: vi.fn().mockReturnValue([]) }));
vi.mock('@background/generation/testGenerator', () => ({
  generateTestSuite: vi.fn(),
  renderGeneratedFiles: vi.fn().mockReturnValue([]),
  repairTestsFromValidation: vi.fn(),
  applyGenerationProgressToJob: vi.fn()
}));
vi.mock('@background/generation/executionValidator', () => ({ validateGeneratedTestsAgainstBaseUrl: vi.fn() }));
vi.mock('@background/generation/zipBuilder', () => ({ buildArtifactZip: vi.fn() }));
vi.mock('@background/generation/readiness', () => ({
  assessReadiness: vi.fn().mockReturnValue({ readiness: 'review_required', notes: [] })
}));
vi.mock('@background/generation/coverage', () => ({
  buildCoverage: vi.fn().mockReturnValue({ coveragePercent: 0, testsGenerated: 0 })
}));
vi.mock('@background/generation/postmanExport', () => ({ buildPostmanCollection: vi.fn().mockReturnValue('{}') }));

describe('service-worker message dispatch', () => {
  let fake: FakeChrome;
  let onMessageHandler: (message: unknown, sender: unknown, sendResponse: (response: EventMessage) => void) => boolean;

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
    const { updateSettings } = await import('@background/core/stateManager');
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

  // -------------------------------------------------------------------------
  // VALIDATE_REPO_ACCESS
  // -------------------------------------------------------------------------

  it('VALIDATE_REPO_ACCESS runs the validator with stored tokens and snapshots the result', async () => {
    const { validateRepoAccess } = await import('@background/repo/validator');
    const { setLastValidation } = await import('@background/core/stateManager');
    const { emitStateSnapshot } = await import('@background/core/emitter');
    vi.mocked(validateRepoAccess).mockResolvedValue({ ok: true, checkedAt: 0, checks: [] });

    const repo = { platform: 'github' as const, owner: 'acme', repo: 'shop-api' };
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'VALIDATE_REPO_ACCESS', payload: { repo } }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(validateRepoAccess).toHaveBeenCalledWith(repo, expect.any(Object));
    expect(setLastValidation).toHaveBeenCalled();
    expect(emitStateSnapshot).toHaveBeenCalled();
    expect(sendResponse.mock.calls[0][0].type).toBe('STATE_SNAPSHOT');
  });

  // -------------------------------------------------------------------------
  // CLEAR_CONTEXT
  // -------------------------------------------------------------------------

  it('CLEAR_CONTEXT clears state and returns a STATE_SNAPSHOT', async () => {
    const { clearContext } = await import('@background/core/stateManager');
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'CLEAR_CONTEXT', contextId: 'tab-9' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(clearContext).toHaveBeenCalledWith('tab-9');
    expect(sendResponse.mock.calls[0][0].type).toBe('STATE_SNAPSHOT');
  });

  // -------------------------------------------------------------------------
  // DOWNLOAD_ARTIFACT — success
  // -------------------------------------------------------------------------

  it('DOWNLOAD_ARTIFACT triggers a chrome download and responds ARTIFACT_DOWNLOADED', async () => {
    const { getArtifactById } = await import('@background/core/stateManager');
    vi.mocked(getArtifactById).mockResolvedValue({
      id: 'artifact-1',
      createdAt: 0,
      fileName: 'api-tests.zip',
      framework: 'jest',
      files: [],
      zipBase64: 'YmFzZTY0'
    });

    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'DOWNLOAD_ARTIFACT', payload: { artifactId: 'artifact-1' } }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(fake.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'api-tests.zip' }));
    expect(sendResponse.mock.calls[0][0].type).toBe('ARTIFACT_DOWNLOADED');
  });

  // -------------------------------------------------------------------------
  // EXPORT_POSTMAN
  // -------------------------------------------------------------------------

  it('EXPORT_POSTMAN errors when there are no generated tests to export', async () => {
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'EXPORT_POSTMAN' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('JOB_ERROR');
    expect((response as { error: string }).error).toContain('No generated tests');
  });

  it('EXPORT_POSTMAN builds a collection and downloads it when tests exist', async () => {
    const { loadState } = await import('@background/core/stateManager');
    const { buildPostmanCollection } = await import('@background/generation/postmanExport');
    vi.mocked(loadState).mockResolvedValue(
      makeAppState({
        settings: makeSettings({ baseUrl: 'http://localhost:4000' }),
        activeJob: {
          jobId: 'j1',
          stage: 'complete',
          startedAt: 0,
          updatedAt: 0,
          progress: 100,
          statusText: 'done',
          totalEndpoints: 1,
          completedBatches: 1,
          totalBatches: 1,
          repo: { platform: 'github', owner: 'acme', repo: 'shop-api' },
          endpoints: [
            {
              id: 'GET::/u',
              method: 'GET',
              path: '/u',
              source: 'express',
              pathParams: [],
              queryParams: [],
              responses: [],
              confidence: 1
            }
          ],
          generatedTests: [
            {
              endpointId: 'GET::/u',
              category: 'positive',
              title: 't',
              request: { method: 'GET', path: '/u' },
              expected: { status: 200 }
            }
          ]
        }
      })
    );

    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'EXPORT_POSTMAN' }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(buildPostmanCollection).toHaveBeenCalled();
    expect(fake.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'APItiser_shop-api_Postman.json' })
    );
    expect(sendResponse.mock.calls[0][0].type).toBe('ACK');
  });

  // -------------------------------------------------------------------------
  // START_SCAN
  // -------------------------------------------------------------------------

  it('START_SCAN runs the scan pipeline and responds with a snapshot', async () => {
    const { scanRepositoryFiles } = await import('@background/repo/scanner');
    vi.mocked(scanRepositoryFiles).mockResolvedValue({ files: [], rateLimited: false } as never);

    const repo = { platform: 'github' as const, owner: 'acme', repo: 'shop-api' };
    const sendResponse = vi.fn<(response: EventMessage) => void>();
    onMessageHandler({ type: 'START_SCAN', payload: { repo } }, {}, sendResponse);

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(scanRepositoryFiles).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalled();
  });
});
