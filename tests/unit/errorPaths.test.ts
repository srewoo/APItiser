import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeChrome } from '../helpers/chromeMock';
import { assessGeneratedTestQuality, normalizeGeneratedTests } from '@background/generation/testGenerator';
import { makeEndpoint, makeGeneratedTestCase } from '@shared/testing/factories';
import type { ApiEndpoint, GeneratedTestCase } from '@shared/types';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// normalizeGeneratedTests — defensive behavior
// ---------------------------------------------------------------------------

describe('normalizeGeneratedTests — defensive behavior', () => {
  const endpoint = makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users' });

  it('returns empty array for non-array input', () => {
    expect(normalizeGeneratedTests(null, ['positive'], [endpoint])).toEqual([]);
    expect(normalizeGeneratedTests(undefined, ['positive'], [endpoint])).toEqual([]);
    expect(normalizeGeneratedTests('bad', ['positive'], [endpoint])).toEqual([]);
    expect(normalizeGeneratedTests({}, ['positive'], [endpoint])).toEqual([]);
  });

  it('drops items with unknown endpointId', () => {
    const input = [
      { endpointId: 'UNKNOWN', category: 'positive', title: 'bad', request: { method: 'GET', path: '/' }, expected: { status: 200 } }
    ];
    expect(normalizeGeneratedTests(input, ['positive'], [endpoint])).toHaveLength(0);
  });

  it('drops items that are not objects', () => {
    const input = [null, undefined, 42, 'string', []] as unknown[];
    expect(normalizeGeneratedTests(input, ['positive'], [endpoint])).toHaveLength(0);
  });

  it('deduplicates identical test cases', () => {
    const item = {
      endpointId: 'GET::/users',
      category: 'positive',
      title: 'gets users',
      request: { method: 'GET', path: '/users' },
      expected: { status: 200 }
    };
    const result = normalizeGeneratedTests([item, item, item], ['positive'], [endpoint]);
    expect(result).toHaveLength(1);
  });

  it('falls back to unknown category as positive when not in allowed list', () => {
    const input = [{
      endpointId: 'GET::/users',
      category: 'unknown-category',
      title: 'gets users',
      request: { method: 'GET', path: '/users' },
      expected: { status: 200 }
    }];
    const result = normalizeGeneratedTests(input, ['positive'], [endpoint]);
    expect(result[0]?.category).toBe('positive');
  });

  it('normalizes non-string header values to strings', () => {
    const input = [{
      endpointId: 'GET::/users',
      category: 'positive',
      title: 'with weird headers',
      request: {
        method: 'GET',
        path: '/users',
        headers: { 'X-Version': 42, 'X-Active': true }
      },
      expected: { status: 200 }
    }];
    const result = normalizeGeneratedTests(input as unknown[], ['positive'], [endpoint]);
    expect(typeof result[0]?.request.headers?.['X-Version']).toBe('string');
    expect(typeof result[0]?.request.headers?.['X-Active']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// assessGeneratedTestQuality — error paths
// ---------------------------------------------------------------------------

describe('assessGeneratedTestQuality — error detection', () => {
  const endpoint = makeEndpoint({
    id: 'POST::/items',
    method: 'POST',
    path: '/items',
    auth: 'bearer',
    responses: [{ status: '200', description: 'OK' }, { status: '400', description: 'Bad Request' }]
  });

  it('flags endpoints with no tests at all', () => {
    const result = assessGeneratedTestQuality([endpoint], [], ['positive']);
    const issue = result.issues.find((i) => i.code === 'missing-endpoint-tests');
    expect(issue).toBeDefined();
    expect(result.passed).toBe(false);
  });

  it('flags endpoints missing a required category', () => {
    const test = makeGeneratedTestCase({ endpointId: 'POST::/items', category: 'positive', expected: { status: 200 } });
    const result = assessGeneratedTestQuality([endpoint], [test], ['positive', 'security']);
    const issue = result.issues.find((i) => i.code === 'missing-category' && i.category === 'security');
    expect(issue).toBeDefined();
  });

  it('flags an invalid status code outside documented responses', () => {
    const test = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      expected: { status: 500 }
    });
    const result = assessGeneratedTestQuality([endpoint], [test], ['positive']);
    const issue = result.issues.find((i) => i.code === 'invalid-status');
    expect(issue).toBeDefined();
  });

  it('flags generic titles', () => {
    const test = makeGeneratedTestCase({
      endpointId: 'POST::/items',
      category: 'positive',
      title: 'api test',
      expected: { status: 200 }
    });
    const result = assessGeneratedTestQuality([endpoint], [test], ['positive']);
    expect(result.issues.find((i) => i.code === 'generic-title')).toBeDefined();
  });

  it('passes when quality is good', () => {
    const tests: GeneratedTestCase[] = [
      makeGeneratedTestCase({
        endpointId: 'POST::/items',
        category: 'positive',
        title: 'POST /items creates item with 200 and returns id',
        request: { method: 'POST', path: '/items', body: { name: 'widget' } },
        expected: { status: 200, contractChecks: ['response matches documented schema'] }
      }),
      makeGeneratedTestCase({
        endpointId: 'POST::/items',
        category: 'negative',
        title: 'POST /items returns 400 for missing required field name',
        request: { method: 'POST', path: '/items', body: {} },
        expected: { status: 400, contractChecks: ['validation error returned'] }
      }),
      makeGeneratedTestCase({
        endpointId: 'POST::/items',
        category: 'security',
        title: 'POST /items returns 401 when authorization header is absent',
        request: { method: 'POST', path: '/items', headers: {} },
        expected: { status: 401 }
      })
    ];
    const result = assessGeneratedTestQuality([endpoint], tests, ['positive', 'negative', 'security']);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stateManager chrome.storage error handling
// ---------------------------------------------------------------------------

describe('stateManager — handles corrupt storage gracefully', () => {
  beforeEach(() => {
    installFakeChrome();
  });

  it('returns default state when stored data is a plain string', async () => {
    const { STORAGE_KEY } = await import('@shared/constants');
    const fake = (globalThis as unknown as { chrome: { storage: { local: { set(v: Record<string, unknown>): Promise<void> } } } }).chrome;
    await fake.storage.local.set({ [STORAGE_KEY]: 'this-is-not-valid-state' });

    const { loadState } = await import('@background/core/stateManager');
    const state = await loadState();
    expect(state.settings).toBeDefined();
    expect(state.activeJob).toBeNull();
  });

  it('returns default state when stored data is null', async () => {
    const { STORAGE_KEY } = await import('@shared/constants');
    const fake = (globalThis as unknown as { chrome: { storage: { local: { set(v: Record<string, unknown>): Promise<void> } } } }).chrome;
    await fake.storage.local.set({ [STORAGE_KEY]: null });

    const { loadState } = await import('@background/core/stateManager');
    const state = await loadState();
    expect(state.activeJob).toBeNull();
  });
});
