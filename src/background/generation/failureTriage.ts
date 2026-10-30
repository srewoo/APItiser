/**
 * Decide who is wrong when a live test fails: the TEST (fix the test) or the API (a likely bug
 * in the user's code). Repair must only ever touch the first kind — "repairing" a test to expect
 * a 500 or to accept an auth bypass would hide exactly the bugs the suite exists to find.
 */
import type { ApiEndpoint, GeneratedTestCase, ValidationResult, ValidationSummary } from '@shared/types';

export type FailureVerdict = 'test' | 'api' | 'missing';

export interface Triage {
  verdict: FailureVerdict;
  reason: string;
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/** Undefined for passes and for connection failures (neither side is at fault). */
export const triageFailure = (result: ValidationResult, test: GeneratedTestCase): Triage | undefined => {
  if (result.success || result.status === undefined) return undefined;
  const status = result.status;
  const types = new Set(result.failures.map((failure) => failure.type));

  if (status >= 500) {
    return { verdict: 'api', reason: `The server errored (HTTP ${status}). A request can't legitimately cause a 5xx — this is a bug in the API.` };
  }
  if (isSuccess(status) && test.category === 'security' && (types.has('status') || types.has('auth'))) {
    return { verdict: 'api', reason: `The API accepted a request it should refuse (HTTP ${status}) — possible authorization/authentication bypass.` };
  }
  if (isSuccess(status) && (test.category === 'negative' || test.category === 'edge') && types.has('status')) {
    return { verdict: 'api', reason: `The API accepted invalid input (HTTP ${status}) instead of rejecting it — missing input validation.` };
  }
  if (types.has('contract')) {
    return { verdict: 'api', reason: "The response breaks the endpoint's documented contract (status, fields or types)." };
  }
  if (types.has('idempotency')) {
    return { verdict: 'api', reason: 'Repeating a request that should be safe to repeat gave a different result.' };
  }
  if (status === 401 || status === 403) {
    return { verdict: 'test', reason: `The API refused the test's credentials (HTTP ${status}) — the test needs a valid token or setup step.` };
  }
  if (status >= 400) {
    return { verdict: 'test', reason: `The API rejected the test's request (HTTP ${status}) — likely a bad payload, a placeholder ID that doesn't exist, or the wrong expected 4xx code.` };
  }
  return { verdict: 'test', reason: "The test's expectations don't match the API's (valid) response." };
};

const hasPathParams = (path: string) => /[:{]/.test(path);

/**
 * Endpoint-level pass: if EVERY request to a parameter-free path got 404, the API has no such
 * route — it was detected from a comment, an example, the frontend, or it lives under a prefix.
 * Per-test "Test needs fixing" would be wrong (no test change can make a missing route answer).
 */
export const markMissingRoutes = (results: ValidationResult[], endpoints: ApiEndpoint[]): ValidationResult[] => {
  const byEndpoint = new Map<string, ValidationResult[]>();
  for (const result of results) byEndpoint.set(result.endpointId, [...(byEndpoint.get(result.endpointId) ?? []), result]);
  const missing = new Set<string>();
  for (const endpoint of endpoints) {
    const own = byEndpoint.get(endpoint.id) ?? [];
    if (own.length && !hasPathParams(endpoint.path) && own.every((result) => result.status === 404)) missing.add(endpoint.id);
  }
  if (!missing.size) return results;
  const label = new Map(endpoints.map((endpoint) => [endpoint.id, `${endpoint.method} ${endpoint.path}`]));
  return results.map((result) =>
    missing.has(result.endpointId)
      ? {
          ...result,
          verdict: 'missing',
          verdictReason:
            `Every request to ${label.get(result.endpointId)} returned 404 — the API has no such route. It was probably detected ` +
            'from a code comment or example, belongs to the frontend, or lives under a prefix (e.g. /api). Fixing the test ' +
            "won't help: exclude this endpoint or correct its path, then generate again."
        }
      : result
  );
};

/** Failures the model may repair: the test is wrong, not the API. */
export const isRepairableResult = (result: ValidationResult): boolean =>
  !result.success && result.verdict === 'test';

export const hasRepairableFailures = (summary: ValidationSummary | undefined): boolean =>
  Boolean(summary?.results.some(isRepairableResult));
