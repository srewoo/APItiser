/**
 * Deterministic security test synthesis.
 *
 * Previously "security coverage" was whatever the model improvised, validated only by a
 * 4xx status and a keyword in the title. This module generates concrete, behaviorally
 * meaningful cases:
 *  - auth-absence: re-issue an authenticated endpoint with NO credentials, expect rejection.
 *  - IDOR: access a resource with a SECONDARY identity (a different user's credentials),
 *    expecting an authorization failure — the canonical broken-object-level-authorization
 *    test, which needs two identities and so was impossible to express before.
 *  - injection: send SQLi / XSS / path-traversal payloads in string fields, expecting the
 *    input to be rejected (rendered as negative cases so the 4xx-class oracle applies).
 */
import { buildExamplePath, sampleValueForField } from '@background/llm/endpointUtils';
import type { ApiEndpoint, GeneratedTestCase, SchemaField, SchemaObject, TestCategory } from '@shared/types';

/** A small, high-signal corpus of injection payloads spanning the common classes. */
export const INJECTION_PAYLOADS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'SQL injection', value: "' OR '1'='1" },
  { label: 'cross-site scripting', value: '<script>alert(1)</script>' },
  { label: 'path traversal', value: '../../../../etc/passwd' }
];

const isSchemaField = (value: SchemaObject | SchemaField): value is SchemaField => 'name' in value;

const stringBodyFields = (body?: SchemaObject): string[] => {
  if (!body || body.type !== 'object' || !body.properties) {
    return [];
  }
  return Object.entries(body.properties)
    .filter(([, value]) => (value.type ?? 'string') === 'string')
    .map(([name]) => name);
};

const buildValidBody = (body?: SchemaObject): Record<string, unknown> => {
  if (!body || body.type !== 'object' || !body.properties) {
    return {};
  }
  const required = new Set(body.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body.properties)) {
    const isRequired = isSchemaField(value) ? value.required || required.has(name) : required.has(name);
    if (isRequired) {
      out[name] = sampleValueForField(name, value.type, isSchemaField(value) ? value.format : undefined);
    }
  }
  return out;
};

const methodTakesBody = (method: string): boolean => ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());

const endpointRequiresAuth = (endpoint: ApiEndpoint): boolean =>
  endpoint.auth !== undefined && endpoint.auth !== 'none' && endpoint.auth !== 'unknown';

const hasIdPathParam = (endpoint: ApiEndpoint): boolean =>
  endpoint.pathParams.some((param) => /id$|^id$|uuid|slug/i.test(param.name)) || /\{[^}]*id[^}]*\}|:\w*id\w*/i.test(endpoint.path);

export const synthesizeSecurityCases = (
  endpoint: ApiEndpoint,
  categories: TestCategory[],
  options: { hasSecondaryIdentity: boolean }
): GeneratedTestCase[] => {
  const cases: GeneratedTestCase[] = [];
  const label = `${endpoint.method} ${endpoint.path}`;
  const concretePath = buildExamplePath(endpoint);

  if (categories.includes('security')) {
    // Auth absence.
    if (endpointRequiresAuth(endpoint)) {
      cases.push({
        endpointId: endpoint.id,
        category: 'security',
        title: `Reject unauthenticated access to ${label}`,
        rationale: 'Authenticated endpoint must reject requests with no credentials.',
        trustScore: 82,
        trustLabel: 'high',
        request: { method: endpoint.method, path: concretePath, headers: {}, query: {}, identity: 'none' },
        expected: { status: 401, contains: [], responseHeaders: {}, contractChecks: [], bodyAssertions: [], pagination: false, idempotent: false }
      });
    }

    // IDOR via a second identity (falls back to unauthenticated when no second identity exists).
    if (hasIdPathParam(endpoint)) {
      const identity = options.hasSecondaryIdentity ? 'secondary' : 'none';
      cases.push({
        endpointId: endpoint.id,
        category: 'security',
        title: options.hasSecondaryIdentity
          ? `IDOR: deny ${label} for a resource owned by another identity`
          : `Authorization: deny ${label} without the owning identity`,
        rationale: 'Object-level authorization must prevent one identity from accessing another\'s resource.',
        trustScore: 82,
        trustLabel: 'high',
        request: { method: endpoint.method, path: concretePath, headers: {}, query: {}, identity },
        expected: { status: 403, contains: [], responseHeaders: {}, contractChecks: [], bodyAssertions: [], pagination: false, idempotent: false }
      });
    }
  }

  // Injection payloads as negative cases (rejection expected → 4xx-class oracle applies).
  // Only for methods that actually accept a body — otherwise the endpoint ignores the payload
  // and the expected 4xx never comes, producing a test that always fails live validation.
  if (categories.includes('negative') && methodTakesBody(endpoint.method)) {
    const targetField = stringBodyFields(endpoint.body)[0];
    if (targetField) {
      const validBody = buildValidBody(endpoint.body);
      for (const payload of INJECTION_PAYLOADS) {
        cases.push({
          endpointId: endpoint.id,
          category: 'negative',
          title: `Reject ${payload.label} payload in "${targetField}" for ${label}`,
          rationale: `${payload.label} input must be rejected or safely handled.`,
          trustScore: 78,
          trustLabel: 'medium',
          request: {
            method: endpoint.method,
            path: concretePath,
            headers: {},
            query: {},
            body: { ...validBody, [targetField]: payload.value }
          },
          expected: {
            status: 400,
            contains: [],
            responseHeaders: {},
            contractChecks: [],
            // Even if accepted, the raw payload must not be reflected verbatim (stored-XSS guard).
            // `[\s\S]` (not `.`) so the negative-lookahead scans the WHOLE multi-line body.
            bodyAssertions: [{ path: '', op: 'matches', value: '^(?![\\s\\S]*<script>)[\\s\\S]*$', description: 'response does not reflect raw script payload' }],
            pagination: false,
            idempotent: false
          }
        });
      }
    }
  }

  return cases;
};
