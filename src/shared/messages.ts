import type { AppState, ExtensionSettings, GeneratedArtifact, RepoRef } from './types';

export type CommandMessage =
  | { type: 'GET_STATE'; contextId?: string }
  | { type: 'SAVE_SETTINGS'; payload: Partial<ExtensionSettings>; contextId?: string }
  | { type: 'VALIDATE_REPO_ACCESS'; payload: { repo: RepoRef }; contextId?: string }
  | { type: 'START_SCAN'; payload: { repo: RepoRef }; contextId?: string }
  | { type: 'START_GENERATION'; contextId?: string }
  | { type: 'CANCEL_JOB'; contextId?: string }
  | { type: 'CLEAR_CONTEXT'; contextId?: string }
  | { type: 'DOWNLOAD_ARTIFACT'; payload: { artifactId: string }; contextId?: string };

export type EventMessage =
  | { type: 'STATE_SNAPSHOT'; payload: AppState; contextId?: string }
  | { type: 'JOB_PROGRESS'; payload: AppState; contextId?: string }
  | { type: 'JOB_COMPLETE'; payload: AppState; contextId?: string }
  | { type: 'JOB_ERROR'; payload: AppState; error: string; contextId?: string }
  | { type: 'SETTINGS_SAVED'; payload: AppState; contextId?: string }
  | { type: 'ARTIFACT_DOWNLOADED'; payload: GeneratedArtifact; contextId?: string }
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
    'DOWNLOAD_ARTIFACT'
  ].includes(message.type);
};
