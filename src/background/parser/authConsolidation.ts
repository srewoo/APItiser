/**
 * Repo-level auth consolidation.
 *
 * Per-endpoint auth detection often guesses inconsistently across one API — bearer here,
 * cookie there, api-key elsewhere — when in reality a service uses a single scheme. That
 * inconsistency produced generated suites that sent the wrong credential per endpoint.
 *
 * This computes the dominant scheme across all endpoints and snaps weakly/inconsistently
 * detected endpoints to it, while preserving (a) endpoints explicitly marked public
 * (`none`) and (b) endpoints whose own detection carries strong contrary evidence.
 */
import type { ApiEndpoint, AuthHint, AuthType } from '@shared/types';

const CONCRETE_SCHEMES: ReadonlySet<AuthType> = new Set(['bearer', 'apiKey', 'cookieSession', 'oauth2', 'csrf']);

const defaultHeaderForScheme = (scheme: AuthType): string | undefined => {
  switch (scheme) {
    case 'bearer':
    case 'oauth2':
      return 'Authorization';
    case 'apiKey':
      return 'X-API-Key';
    case 'csrf':
      return 'X-CSRF-Token';
    case 'cookieSession':
      return 'Cookie';
    default:
      return undefined;
  }
};

const STRONG_EVIDENCE = 0.8;

const hasStrongOwnEvidence = (endpoint: ApiEndpoint): boolean =>
  (endpoint.authHints ?? []).some((hint) => hint.type === endpoint.auth && (hint.confidence ?? 0) >= STRONG_EVIDENCE);

const harmonizeHints = (existing: AuthHint[] | undefined, scheme: AuthType): AuthHint[] => {
  const hints = (existing ?? []).filter((hint) => hint.type === scheme);
  if (hints.length) {
    return hints;
  }
  const headerName = defaultHeaderForScheme(scheme);
  return [
    {
      type: scheme,
      headerName,
      confidence: 0.6,
      evidence: 'repo-level consolidated scheme'
    }
  ];
};

export interface AuthConsolidationResult {
  endpoints: ApiEndpoint[];
  dominantScheme?: AuthType;
  changed: number;
}

/**
 * Tally concrete schemes seen across endpoints and their hints. Returns the most common one,
 * or undefined when no endpoint carries a concrete scheme.
 */
const dominantScheme = (endpoints: ApiEndpoint[]): AuthType | undefined => {
  const tally = new Map<AuthType, number>();
  const bump = (type?: AuthType): void => {
    if (type && CONCRETE_SCHEMES.has(type)) {
      tally.set(type, (tally.get(type) ?? 0) + 1);
    }
  };
  for (const endpoint of endpoints) {
    bump(endpoint.auth);
    for (const hint of endpoint.authHints ?? []) {
      bump(hint.type);
    }
  }
  if (!tally.size) {
    return undefined;
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

export const consolidateAuth = (endpoints: ApiEndpoint[]): AuthConsolidationResult => {
  const dominant = dominantScheme(endpoints);
  if (!dominant) {
    return { endpoints, changed: 0 };
  }

  let changed = 0;
  const updated = endpoints.map((endpoint) => {
    // Preserve explicitly public endpoints and those that already match the consensus.
    if (endpoint.auth === 'none' || endpoint.auth === dominant) {
      return endpoint;
    }
    // Preserve endpoints whose own detection is strongly evidenced, even if it disagrees.
    if (hasStrongOwnEvidence(endpoint)) {
      return endpoint;
    }
    changed += 1;
    return {
      ...endpoint,
      auth: dominant,
      authHints: harmonizeHints(endpoint.authHints, dominant)
    };
  });

  return { endpoints: updated, dominantScheme: dominant, changed };
};
