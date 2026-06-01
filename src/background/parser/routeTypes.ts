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
  /** Query parameters recovered from the route declaration or handler signature. */
  queryParams?: ApiEndpoint['queryParams'];
  /** Path parameters recovered with richer typing than the path string alone implies. */
  pathParams?: ApiEndpoint['pathParams'];
  /** Request body schema recovered from the handler (DTO, Pydantic model, destructuring, etc.). */
  body?: ApiEndpoint['body'];
  /** Response signals recovered from the handler (status codes returned). */
  responses?: ApiEndpoint['responses'];
  /** Short human summary recovered from the route (operationId-like). */
  summary?: string;
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
