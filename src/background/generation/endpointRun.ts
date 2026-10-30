/**
 * Pure helpers behind "run tests for one endpoint": pick the tests to fire and fold the run's
 * results into the job's existing validation summary.
 */
import type { GeneratedTestCase, ValidationResult, ValidationSummary } from '@shared/types';

const resultKey = (endpointId: string, title: string): string => `${endpointId}\u0000${title}`;

/**
 * Tests for the given endpoints, plus the suite's lifecycle setup/teardown tests (they create
 * the resources `{{ID}}`-bearing requests depend on). Original order is preserved, which the
 * validator relies on for create → use → teardown sequencing. No ids = the whole suite.
 */
export const selectTestsForEndpoints = (
  tests: GeneratedTestCase[],
  endpointIds?: string[]
): GeneratedTestCase[] => {
  if (!endpointIds?.length) {
    return tests;
  }
  const wanted = new Set(endpointIds);
  if (!tests.some((test) => wanted.has(test.endpointId))) {
    return [];
  }
  return tests.filter((test) => wanted.has(test.endpointId) || test.isSetup || test.isTeardown);
};

const countSummary = (results: ValidationResult[]): Pick<ValidationSummary, 'attempted' | 'passed' | 'failed'> => {
  const passed = results.filter((result) => result.success).length;
  return { attempted: results.length, passed, failed: results.length - passed };
};

/** Replace the previous results for tests that just ran; keep everything else. */
export const mergeValidationSummary = (
  previous: ValidationSummary | undefined,
  run: ValidationSummary,
  ranTests: GeneratedTestCase[]
): ValidationSummary => {
  const ran = new Set(ranTests.map((test) => resultKey(test.endpointId, test.title)));
  const kept = (previous?.results ?? []).filter((result) => !ran.has(resultKey(result.endpointId, result.title)));
  const results = [...kept, ...run.results];
  return {
    ...run,
    ...countSummary(results),
    repaired: previous?.repaired ?? 0,
    results
  };
};

/**
 * Summary for an in-flight run: old results for the tests being run are dropped up front so
 * the UI shows only fresh results as they stream in.
 */
export const liveSummary = (
  previous: ValidationSummary | undefined,
  streamed: ValidationResult[],
  runningTests: GeneratedTestCase[],
  targetBaseUrl: string
): ValidationSummary =>
  mergeValidationSummary(
    previous,
    { attempted: 0, passed: 0, failed: 0, repaired: 0, skipped: 0, lastValidatedAt: Date.now(), results: streamed, targetBaseUrl },
    runningTests
  );
