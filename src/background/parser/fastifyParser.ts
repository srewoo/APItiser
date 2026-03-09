import type { ApiEndpoint, RepoFile } from '@shared/types';
import { parseCodeRoutes } from './codeRouteParser';

export const parseFastifyRoutes = (files: RepoFile[]): ApiEndpoint[] =>
  parseCodeRoutes(files).filter((endpoint) => endpoint.source === 'fastify');
