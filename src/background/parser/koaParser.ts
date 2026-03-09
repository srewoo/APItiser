import type { ApiEndpoint, RepoFile } from '@shared/types';
import { parseCodeRoutes } from './codeRouteParser';

export const parseKoaRoutes = (files: RepoFile[]): ApiEndpoint[] =>
  parseCodeRoutes(files).filter((endpoint) => endpoint.source === 'koa');
