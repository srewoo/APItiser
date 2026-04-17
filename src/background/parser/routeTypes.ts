import type { ApiEndpoint, EndpointEvidence, RepoFile } from '@shared/types';

export interface ImportBinding {
  source: string;
  imported: string;
  resolvedPath?: string;
}

export interface RouteSignal {
  method: string;
  path: string;
  source: ApiEndpoint['source'];
  owner: string;
  file: RepoFile;
  confidence: number;
  evidence: EndpointEvidence[];
}

export interface MountSignal {
  file: RepoFile;
  parentOwner: string;
  childOwner: string;
  prefix: string;
  confidencePenalty: number;
  evidence: EndpointEvidence;
}

export interface FileAnalysis {
  file: RepoFile;
  imports: Map<string, ImportBinding>;
  routes: RouteSignal[];
  mounts: MountSignal[];
  ownerKind: Map<string, ApiEndpoint['source']>;
  namedExports: Map<string, string>;
  defaultExportOwner?: string;
}
