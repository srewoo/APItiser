import { describe, expect, it } from 'vitest';
import { liveSummary, mergeValidationSummary, selectTestsForEndpoints } from '@background/generation/endpointRun';
import { isLoopbackUrl } from '@shared/localUrl';
import { makeGeneratedTestCase, makeValidationResult, makeValidationSummary } from '@shared/testing/factories';

const usersGet = makeGeneratedTestCase({ endpointId: 'GET::/users', title: 'list users' });
const usersCreate = makeGeneratedTestCase({ endpointId: 'POST::/users', title: 'create user', isSetup: true, order: 0 });
const orderGet = makeGeneratedTestCase({ endpointId: 'GET::/orders', title: 'list orders' });
const suite = [usersCreate, usersGet, orderGet];

describe('selectTestsForEndpoints', () => {
  it('returns the whole suite when no endpoints are given', () => {
    expect(selectTestsForEndpoints(suite)).toEqual(suite);
    expect(selectTestsForEndpoints(suite, [])).toEqual(suite);
  });

  it('keeps the endpoint tests plus lifecycle setup, in original order', () => {
    expect(selectTestsForEndpoints(suite, ['GET::/orders'])).toEqual([usersCreate, orderGet]);
  });

  it('returns nothing for an endpoint without tests (no orphan setup run)', () => {
    expect(selectTestsForEndpoints(suite, ['DELETE::/nope'])).toEqual([]);
  });
});

describe('mergeValidationSummary', () => {
  it('replaces results for the tests that ran and recounts', () => {
    const previous = makeValidationSummary({
      attempted: 2,
      passed: 1,
      failed: 1,
      repaired: 1,
      results: [
        makeValidationResult({ endpointId: 'GET::/users', title: 'list users', success: false }),
        makeValidationResult({ endpointId: 'GET::/orders', title: 'list orders', success: true })
      ]
    });
    const run = makeValidationSummary({
      results: [makeValidationResult({ endpointId: 'GET::/users', title: 'list users', success: true })],
      targetBaseUrl: 'http://localhost:8080'
    });

    const merged = mergeValidationSummary(previous, run, [usersGet]);

    expect(merged.results).toHaveLength(2);
    expect(merged).toMatchObject({ attempted: 2, passed: 2, failed: 0, repaired: 1, targetBaseUrl: 'http://localhost:8080' });
  });

  it('works with no previous summary', () => {
    const merged = mergeValidationSummary(undefined, makeValidationSummary(), [usersGet]);
    expect(merged.attempted).toBe(1);
    expect(merged.repaired).toBe(0);
  });
});

describe('liveSummary', () => {
  it('drops stale results for in-flight tests and shows streamed ones', () => {
    const previous = makeValidationSummary({
      results: [makeValidationResult({ endpointId: 'GET::/users', title: 'list users', success: false })]
    });
    const empty = liveSummary(previous, [], [usersGet], 'http://localhost:1');
    expect(empty.results).toEqual([]);

    const streamed = liveSummary(previous, [makeValidationResult({ endpointId: 'GET::/users', title: 'list users' })], [usersGet], 'http://localhost:1');
    expect(streamed).toMatchObject({ attempted: 1, passed: 1 });
  });
});

describe('isLoopbackUrl', () => {
  it.each([
    ['http://localhost:3000', true],
    ['http://127.0.0.1:8080/api', true],
    ['http://[::1]:8080', true],
    ['http://api.localhost', true],
    ['https://api.example.com', false],
    ['http://localhost.evil.com', false],
    ['http://10.0.0.5', false],
    ['not a url', false]
  ])('%s → %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});
