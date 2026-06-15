import type { GeneratedTestCase } from '@shared/types';

/**
 * What HTTP status a generated test should accept.
 *
 * Positive tests assert an exact documented success code. Negative, security, and
 * error-class edge tests only need to land in the right status *class* — a model that
 * guesses 400 when the API answers 422 should not produce a false failure, since both
 * are correct "the request was rejected" outcomes. Asserting an exact code on those
 * categories is brittle and was the most common source of spurious validation failures.
 */
export interface StatusExpectation {
  kind: 'exact' | 'class';
  /** Populated when kind === 'exact'. */
  code?: number;
  /** Populated when kind === 'class'. */
  min?: number;
  max?: number;
}

export const statusExpectation = (test: GeneratedTestCase): StatusExpectation => {
  const status = test.expected.status;

  if (test.category === 'positive') {
    return { kind: 'exact', code: status };
  }

  if (test.category === 'negative' || test.category === 'security') {
    // Any client-error response satisfies a rejection-oriented test.
    return { kind: 'class', min: 400, max: 499 };
  }

  // Edge cases can be either a valid success or a boundary rejection; accept the class
  // that matches the asserted status so we don't over-constrain the specific code.
  if (status >= 400) {
    return { kind: 'class', min: 400, max: 499 };
  }
  return { kind: 'class', min: 200, max: 299 };
};

/** Does an observed status satisfy the test's expectation? Used by live validation. */
export const statusSatisfied = (test: GeneratedTestCase, actual: number): boolean => {
  const expectation = statusExpectation(test);
  if (expectation.kind === 'exact') {
    return actual === expectation.code;
  }
  return actual >= (expectation.min ?? 0) && actual <= (expectation.max ?? 599);
};

/** Human-readable label for the expectation, e.g. "200" or "400-499". */
export const statusExpectationLabel = (test: GeneratedTestCase): string => {
  const expectation = statusExpectation(test);
  return expectation.kind === 'exact'
    ? String(expectation.code)
    : `${expectation.min}-${expectation.max}`;
};

/** jest / vitest / supertest assertion (Jest `expect` matchers). */
export const renderStatusAssertionJs = (test: GeneratedTestCase, statusExpr: string, indent: string): string => {
  const expectation = statusExpectation(test);
  if (expectation.kind === 'exact') {
    return `${indent}expect(${statusExpr}).toBe(${expectation.code});`;
  }
  return `${indent}expect(${statusExpr}).toBeGreaterThanOrEqual(${expectation.min});\n${indent}expect(${statusExpr}).toBeLessThanOrEqual(${expectation.max});`;
};

/** mocha + chai assertion. */
export const renderStatusAssertionChai = (test: GeneratedTestCase, statusExpr: string, indent: string): string => {
  const expectation = statusExpectation(test);
  if (expectation.kind === 'exact') {
    return `${indent}expect(${statusExpr}).to.equal(${expectation.code});`;
  }
  return `${indent}expect(${statusExpr}).to.be.at.least(${expectation.min});\n${indent}expect(${statusExpr}).to.be.at.most(${expectation.max});`;
};

/** pytest assertion. */
export const renderStatusAssertionPy = (test: GeneratedTestCase, statusExpr: string, indent: string): string => {
  const expectation = statusExpectation(test);
  if (expectation.kind === 'exact') {
    return `${indent}assert ${statusExpr} == ${expectation.code}`;
  }
  return `${indent}assert ${expectation.min} <= ${statusExpr} <= ${expectation.max}`;
};

/**
 * Go (testing) assertion. `statusExpr` is the status int expression and `bodyExpr` a
 * string expression for the response body used in the failure message.
 */
export const renderStatusAssertionGo = (test: GeneratedTestCase, statusExpr: string, bodyExpr: string, indent: string): string => {
  const expectation = statusExpectation(test);
  if (expectation.kind === 'exact') {
    return `${indent}if ${statusExpr} != ${expectation.code} {\n${indent}\tt.Errorf("status = %d, want ${expectation.code}; body=%s", ${statusExpr}, ${bodyExpr})\n${indent}}`;
  }
  return `${indent}if ${statusExpr} < ${expectation.min} || ${statusExpr} > ${expectation.max} {\n${indent}\tt.Errorf("status = %d, want ${expectation.min}-${expectation.max}; body=%s", ${statusExpr}, ${bodyExpr})\n${indent}}`;
};

/** Java / rest-assured (JUnit) assertion. `statusExpr` returns the int status code. */
export const renderStatusAssertionJava = (test: GeneratedTestCase, statusExpr: string, bodyExpr: string, indent: string): string => {
  const expectation = statusExpectation(test);
  if (expectation.kind === 'exact') {
    return `${indent}assertEquals(${expectation.code}, ${statusExpr}, "status mismatch; body=" + ${bodyExpr});`;
  }
  return `${indent}assertTrue(${statusExpr} >= ${expectation.min} && ${statusExpr} <= ${expectation.max}, "status " + ${statusExpr} + " not in ${expectation.min}-${expectation.max}; body=" + ${bodyExpr});`;
};
