/**
 * Shared utilities used by both `promptBuilder.ts` and `testGenerator.ts`.
 * Centralises endpoint-to-sample-value logic to eliminate duplication.
 */
import type { ApiEndpoint } from '@shared/types';

export const METHOD_DEFAULTS: Record<string, number> = {
  GET: 200,
  POST: 201,
  PUT: 200,
  PATCH: 200,
  DELETE: 204,
  OPTIONS: 200,
  HEAD: 200
};

/** Returns a realistic sample value for a named parameter. */
export const sampleValueForField = (name: string, type?: string, format?: string): string | number | boolean => {
  const normalizedName = name.toLowerCase();
  const normalizedType = (type ?? '').toLowerCase();
  const normalizedFormat = (format ?? '').toLowerCase();

  if (normalizedFormat === 'uuid' || normalizedName.includes('uuid')) {
    return '00000000-0000-4000-8000-000000000000';
  }
  if (normalizedFormat === 'email' || normalizedName.includes('email')) {
    return 'user@example.com';
  }
  if (normalizedType === 'integer' || normalizedType === 'number' || normalizedName === 'id' || normalizedName.endsWith('id')) {
    return 1;
  }
  if (normalizedType === 'boolean') {
    return true;
  }

  return `${normalizedName || 'sample'}-value`;
};

/** Same as sampleValueForField but always returns a string (for path substitution). */
export const sampleValueForParam = (name: string, type?: string, format?: string): string =>
  String(sampleValueForField(name, type, format));

/** Replaces path param placeholders with realistic sample values. */
export const buildExamplePath = (endpoint: ApiEndpoint): string => {
  const paramsByName = new Map(endpoint.pathParams.map((param) => [param.name, param]));

  return endpoint.path
    .replace(/:([A-Za-z0-9_]+)\*/g, (_match, name: string) =>
      sampleValueForParam(name, paramsByName.get(name)?.type, paramsByName.get(name)?.format))
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
      sampleValueForParam(name, paramsByName.get(name)?.type, paramsByName.get(name)?.format))
    .replace(/\{([^}]+)\}/g, (_match, name: string) =>
      sampleValueForParam(name, paramsByName.get(name)?.type, paramsByName.get(name)?.format));
};

/** Returns the expected 2xx status for an endpoint, falling back to METHOD_DEFAULTS. */
export const defaultExpectedStatus = (endpoint: ApiEndpoint): number => {
  const documented = endpoint.responses
    .map((response) => Number(response.status))
    .find((status) => Number.isFinite(status) && status >= 200 && status < 300);

  return documented ?? METHOD_DEFAULTS[endpoint.method] ?? 200;
};
