import type { AppState, ExtensionSettings, GeneratedArtifact, RepoRef } from './types';

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
  | { type: 'DOWNLOAD_RUNNER'; contextId?: string }
  | { type: 'CHECK_LOCAL_RUNNER'; contextId?: string };

export interface LocalRunnerStatus {
  hostOk: boolean;
  hostMessage?: string;
  serviceOk: boolean;
  serviceMessage?: string;
}

export type EventMessage =
  | { type: 'STATE_SNAPSHOT'; payload: AppState; contextId?: string }
  | { type: 'JOB_PROGRESS'; payload: AppState; contextId?: string }
  | { type: 'JOB_COMPLETE'; payload: AppState; contextId?: string }
  | { type: 'JOB_ERROR'; payload: AppState; error: string; contextId?: string }
  | { type: 'SETTINGS_SAVED'; payload: AppState; contextId?: string }
  | { type: 'ARTIFACT_DOWNLOADED'; payload: GeneratedArtifact; contextId?: string }
  | { type: 'LOCAL_RUNNER_STATUS'; payload: LocalRunnerStatus; contextId?: string }
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
    'DOWNLOAD_RUNNER',
    'CHECK_LOCAL_RUNNER'
  ].includes(message.type);
};
