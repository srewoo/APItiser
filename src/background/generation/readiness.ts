import type { GeneratedTestCase, ReadinessState, ValidationSummary } from '@shared/types';

export interface ReadinessAssessment {
  readiness: ReadinessState;
  notes: string[];
}

const hasStrongAssertions = (test: GeneratedTestCase): boolean =>
  Boolean(test.expected.contentType || test.expected.jsonSchema || (test.expected.contractChecks?.length ?? 0) > 0);

export const assessReadiness = (
  tests: GeneratedTestCase[],
  validationSummary?: ValidationSummary
): ReadinessAssessment => {
  if (!tests.length) {
    return {
      readiness: 'scaffold',
      notes: ['No tests were generated.']
    };
  }

  if (!validationSummary || validationSummary.notRunReason || validationSummary.attempted === 0) {
    return {
      readiness: 'review_required',
      notes: [
        validationSummary?.notRunReason || 'Live validation did not run for the generated suite.'
      ]
    };
  }

  if (validationSummary.failed > 0) {
    return {
      readiness: 'review_required',
      notes: [`${validationSummary.failed} generated tests still failed live validation.`]
    };
  }

  const heuristicCount = tests.filter((test) => test.trustLabel === 'heuristic' || (test.trustScore ?? 0) < 0.55).length;
  const strongAssertionCount = tests.filter(hasStrongAssertions).length;
  const notes: string[] = [];

  if (heuristicCount > 0) {
    notes.push(`${heuristicCount} tests still rely on heuristic endpoint evidence.`);
  }

  if (strongAssertionCount < tests.length) {
    notes.push(`${tests.length - strongAssertionCount} tests are missing schema or contract assertions.`);
  }

  const canBeProductionCandidate = heuristicCount === 0
    && strongAssertionCount === tests.length
    && (validationSummary.repaired ?? 0) <= 1;

  return {
    readiness: canBeProductionCandidate ? 'production_candidate' : 'validated',
    notes
  };
};
