import type { ApiEndpoint, RepoFile } from '@shared/types';
import { parseCodeRoutes } from './codeRouteParser';
import { parseOpenApiSpecs } from './openApiParser';
import { canonicalizeEndpoints } from './canonicalize';

export const parseApiMap = (files: RepoFile[]): ApiEndpoint[] => {
  let codeEndpoints: ApiEndpoint[] = [];
  let openApiEndpoints: ApiEndpoint[] = [];

  try {
    codeEndpoints = parseCodeRoutes(files);
  } catch (error) {
    console.warn('[APItiser] Code route parsing failed during scan.', error);
  }

  try {
    openApiEndpoints = parseOpenApiSpecs(files);
  } catch (error) {
    console.warn('[APItiser] OpenAPI parsing failed during scan.', error);
  }

  return canonicalizeEndpoints([...openApiEndpoints, ...codeEndpoints], files);
};
