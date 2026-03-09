import type { ApiEndpoint, RepoFile } from '@shared/types';
import { parseCodeRoutes } from './codeRouteParser';

export const parsePythonRoutes = (files: RepoFile[]): ApiEndpoint[] =>
  parseCodeRoutes(files).filter((endpoint) => endpoint.source === 'fastapi' || endpoint.source === 'flask');
