import type { AppState, CodeFixProposal, ExtensionSettings, GeneratedArtifact, GeneratedTestCase, HostPlatform, LLMProvider, RepoRef } from './types';

export type CommandMessage =
  | { type: 'GET_STATE'; contextId?: string }
  | { type: 'SAVE_SETTINGS'; payload: Partial<ExtensionSettings>; contextId?: string }
  | { type: 'VALIDATE_REPO_ACCESS'; payload: { repo: RepoRef }; contextId?: string }
  | { type: 'START_SCAN'; payload: { repo: RepoRef }; contextId?: string }
  | { type: 'START_GENERATION'; payload?: { selectedEndpointIds?: string[] }; contextId?: string }
  | { type: 'CANCEL_JOB'; contextId?: string }
  | { type: 'CLEAR_CONTEXT'; contextId?: string }
  | { type: 'DOWNLOAD_ARTIFACT'; payload: { artifactId: string }; contextId?: string }
  | { type: 'EXPORT_POSTMAN'; contextId?: string }
  | { type: 'RUN_LOCALLY'; contextId?: string }
  | { type: 'RUN_REPO_TESTS'; contextId?: string }
  | { type: 'START_LOCAL_SERVICE'; payload?: { repo?: RepoRef }; contextId?: string }
  | { type: 'STOP_LOCAL_SERVICE'; contextId?: string }
  | { type: 'RUN_ENDPOINT_TESTS'; payload?: { endpointIds?: string[] }; contextId?: string }
  | { type: 'PICK_FOLDER'; payload?: { prompt?: string }; contextId?: string }
  | { type: 'PROPOSE_TEST_FIX'; payload: { endpointId: string; title: string }; contextId?: string }
  | { type: 'APPLY_TEST_FIX'; payload: { endpointId: string; title: string; test: GeneratedTestCase }; contextId?: string }
  | { type: 'PROPOSE_CODE_FIX'; payload: { endpointId: string; title: string }; contextId?: string }
  | { type: 'APPLY_CODE_FIX'; payload: { proposal: CodeFixProposal }; contextId?: string }
  | { type: 'UNDO_CODE_FIX'; contextId?: string }
  | { type: 'DOWNLOAD_RUNNER'; contextId?: string }
  | { type: 'CHECK_LOCAL_RUNNER'; contextId?: string }
  | { type: 'TEST_PROVIDER_KEY'; payload: { provider: LLMProvider; apiKey: string; baseUrl?: string }; contextId?: string }
  | { type: 'TEST_REPO_TOKEN'; payload: { platform: HostPlatform; token: string; baseUrl?: string }; contextId?: string }
  | { type: 'TEST_ATLASSIAN_TOKEN'; payload: { siteUrl: string; email: string; token: string }; contextId?: string };

/** Shown when Start finds no native host; the panel then offers the installer download. */
export const RUNNER_NOT_INSTALLED =
  "The APItiser local runner isn't installed on this computer yet. Download it below, unzip, and run install.sh once — then press Start again.";

export interface LocalRunnerStatus {
  hostOk: boolean;
  hostMessage?: string;
  serviceOk: boolean;
  serviceMessage?: string;
}

export interface ProviderKeyStatus {
  ok: boolean;
  message: string;
  /** Text-generation models the key can use (provider key tests only), newest first. */
  models?: string[];
}

export type EventMessage =
  | { type: 'STATE_SNAPSHOT'; payload: AppState; contextId?: string }
  | { type: 'JOB_PROGRESS'; payload: AppState; contextId?: string }
  | { type: 'JOB_COMPLETE'; payload: AppState; contextId?: string }
  | { type: 'JOB_ERROR'; payload: AppState; error: string; contextId?: string }
  | { type: 'SETTINGS_SAVED'; payload: AppState; contextId?: string }
  | { type: 'ARTIFACT_DOWNLOADED'; payload: GeneratedArtifact; contextId?: string }
  | { type: 'LOCAL_RUNNER_STATUS'; payload: LocalRunnerStatus; contextId?: string }
  | { type: 'FOLDER_PICKED'; payload: { path?: string; origin?: string; cancelled?: boolean }; contextId?: string }
  | { type: 'CODE_FIX_PROPOSAL'; payload: CodeFixProposal; contextId?: string }
  | {
      type: 'TEST_FIX_PROPOSAL';
      payload: { endpointId: string; title: string; before: GeneratedTestCase; after: GeneratedTestCase };
      contextId?: string;
    }
  | { type: 'PROVIDER_KEY_STATUS'; payload: ProviderKeyStatus; contextId?: string }
  | { type: 'REPO_TOKEN_STATUS'; payload: ProviderKeyStatus; contextId?: string }
  | { type: 'ATLASSIAN_TOKEN_STATUS'; payload: ProviderKeyStatus; contextId?: string }
  | { type: 'ACK' };

export type RuntimeMessage = CommandMessage | EventMessage;

export const isCommandMessage = (message: RuntimeMessage): message is CommandMessage => {
  return [
    'GET_STATE',
    'SAVE_SETTINGS',
    'VALIDATE_REPO_ACCESS',
    'START_SCAN',
    'START_GENERATION',
    'CANCEL_JOB',
    'CLEAR_CONTEXT',
    'DOWNLOAD_ARTIFACT',
    'EXPORT_POSTMAN',
    'RUN_LOCALLY',
    'RUN_REPO_TESTS',
    'START_LOCAL_SERVICE',
    'STOP_LOCAL_SERVICE',
    'RUN_ENDPOINT_TESTS',
    'PICK_FOLDER',
    'PROPOSE_TEST_FIX',
    'APPLY_TEST_FIX',
    'PROPOSE_CODE_FIX',
    'APPLY_CODE_FIX',
    'UNDO_CODE_FIX',
    'DOWNLOAD_RUNNER',
    'CHECK_LOCAL_RUNNER',
    'TEST_PROVIDER_KEY',
    'TEST_REPO_TOKEN',
    'TEST_ATLASSIAN_TOKEN'
  ].includes(message.type);
};
