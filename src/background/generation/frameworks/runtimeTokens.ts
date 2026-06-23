/**
 * Rendering helpers for `{{NAME}}` runtime placeholders in request paths.
 *
 * A generated test path may contain placeholders like `/users/{{USER_ID}}` when the id
 * cannot be known at generation time (it belongs to another resource). Rather than baking
 * a fabricated value that 404s against a real API, the suite reads the value from an
 * environment variable at run time, and APItiser's own live validation resolves the same
 * token from its runtime-value registry. These helpers emit the per-language code for that.
 */

import type { GeneratedTestCase, RequestIdentity } from '@shared/types';

const RUNTIME_TOKEN_RE = /\{\{(\w+)\}\}/g;

export const hasRuntimeToken = (path: string): boolean => /\{\{\w+\}\}/.test(path);

const AUTH_HEADER_RE = /^(authorization|cookie|x-api-key|x-csrf-token|csrf-token)$/i;

/**
 * The headers a generated test should send for its identity:
 *  - `none`: strip all auth headers (deliberately unauthenticated).
 *  - `secondary`: send the foreign identity's bearer token (env API_TOKEN_SECONDARY).
 *  - `primary`/undefined: the headers as generated (auth already injected).
 */
export const identityHeaders = (testCase: GeneratedTestCase): Record<string, string> => {
  const identity: RequestIdentity = testCase.request.identity ?? 'primary';
  const base = { ...(testCase.request.headers ?? {}) };
  if (identity === 'none') {
    return Object.fromEntries(Object.entries(base).filter(([key]) => !AUTH_HEADER_RE.test(key)));
  }
  if (identity === 'secondary') {
    return { ...base, Authorization: 'Bearer {{API_TOKEN_SECONDARY}}' };
  }
  return base;
};

/**
 * A JS expression for a header value. Any `{{NAME}}` placeholder becomes an env read so the
 * generated suite is environment-backed (covers auth tokens and arbitrary runtime values).
 */
export const jsHeaderValueExpr = (value: string): string => {
  if (!hasRuntimeToken(value)) {
    return JSON.stringify(value);
  }
  const tmpl = value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(RUNTIME_TOKEN_RE, (_match, name: string) => '${process.env.' + name + " || 'replace-me'}");
  return '`' + tmpl + '`';
};

/**
 * Path text for embedding inside an existing JS template literal (jest/vitest/mocha/
 * playwright build the URL as `${BASE_URL}${path}`). Tokens become `${process.env.NAME ...}`.
 * Returns the path unchanged when it has no tokens.
 */
export const jsTemplatePath = (path: string): string =>
  path.replace(RUNTIME_TOKEN_RE, (_match, name: string) => '${process.env.' + name + " || 'replace-me'}");

/** Standalone JS expression for the path (supertest passes it to `.get(...)`). */
export const jsPathExpr = (path: string): string =>
  hasRuntimeToken(path) ? '`' + jsTemplatePath(path) + '`' : JSON.stringify(path);

/**
 * Generic string-concatenation expression builder for languages without interpolation in
 * this context (Python/Go/Java). Literal segments are encoded with `litFn`, each token via
 * `tokenFn`. Only call when `hasRuntimeToken(path)` is true.
 */
export const pathConcat = (
  path: string,
  tokenFn: (name: string) => string,
  litFn: (literal: string) => string
): string => {
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  RUNTIME_TOKEN_RE.lastIndex = 0;
  while ((match = RUNTIME_TOKEN_RE.exec(path)) !== null) {
    if (match.index > lastIndex) {
      parts.push(litFn(path.slice(lastIndex, match.index)));
    }
    parts.push(tokenFn(match[1]));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < path.length) {
    parts.push(litFn(path.slice(lastIndex)));
  }
  return parts.join(' + ');
};

/** Python path expression: `BASE_URL + "/users/" + os.getenv("USER_ID", "replace-me")`. */
export const pyPathExpr = (path: string, litFn: (literal: string) => string): string => {
  if (!hasRuntimeToken(path)) {
    return `BASE_URL + ${litFn(path)}`;
  }
  return `BASE_URL + ${pathConcat(path, (name) => `os.getenv(${JSON.stringify(name)}, 'replace-me')`, litFn)}`;
};

/** Go path expression body (placed after `baseURL + `). */
export const goPathExpr = (path: string, litFn: (literal: string) => string): string =>
  hasRuntimeToken(path)
    ? pathConcat(path, (name) => `getEnv(${JSON.stringify(name)}, "replace-me")`, litFn)
    : litFn(path);

/** Java path expression: `"/users/" + System.getenv().getOrDefault("USER_ID", "replace-me")`. */
export const javaPathExpr = (path: string, litFn: (literal: string) => string): string =>
  hasRuntimeToken(path)
    ? pathConcat(path, (name) => `System.getenv().getOrDefault(${JSON.stringify(name)}, "replace-me")`, litFn)
    : litFn(path);
