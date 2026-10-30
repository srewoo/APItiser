/**
 * "Fix this test" on demand: ask the model for a corrected version of ONE failing test, for the
 * user to review as a diff. Nothing changes until they accept. Refuses likely API bugs — those
 * need a code fix, and "fixing" the test would hide them.
 */
import type { ExtensionSettings, GeneratedTestCase, JobState } from '@shared/types';
import { repairTestsFromValidation } from '../generation/testGenerator';

export interface TestFixProposal {
  endpointId: string;
  title: string;
  before: GeneratedTestCase;
  after: GeneratedTestCase;
}

// What a reviewer cares about. Internal bookkeeping (e.g. lifecycle `order`) changing alone is
// not a fix and must not be offered as one.
const meaningful = (test: GeneratedTestCase) =>
  JSON.stringify({ title: test.title, category: test.category, request: test.request, expected: test.expected });

const sameTest = (test: { endpointId: string; title: string }, endpointId: string, title: string) =>
  test.endpointId === endpointId && test.title === title;

export const proposeTestFix = async (options: {
  settings: ExtensionSettings;
  job: JobState;
  endpointId: string;
  title: string;
  signal?: AbortSignal;
}): Promise<TestFixProposal> => {
  const { job, endpointId, title } = options;
  const before = job.generatedTests.find((test) => sameTest(test, endpointId, title));
  const result = job.validationSummary?.results.find((item) => sameTest(item, endpointId, title));
  const endpoint = job.endpoints.find((item) => item.id === endpointId);
  if (!before || !result || !endpoint || !job.repo) {
    throw new Error('Run this test first — there is no failure to fix yet.');
  }
  if (result.success) throw new Error('This test already passes.');
  if (result.verdict === 'api') {
    throw new Error("This failure looks like a bug in the API, not the test — use “Propose a code fix” instead.");
  }
  if (result.verdict === 'missing') {
    throw new Error("The API has no such route, so no test change can fix this — exclude the endpoint or correct its path.");
  }

  const repaired = await repairTestsFromValidation({
    settings: options.settings,
    repo: job.repo,
    endpoints: [endpoint],
    tests: [before],
    validationSummary: { ...job.validationSummary!, results: [result] },
    signal: options.signal
  });
  const after = repaired.find((test) => test.title === title) ?? repaired.find((test) => test.endpointId === endpointId);
  if (!after || meaningful(after) === meaningful(before)) {
    throw new Error("The model couldn't find a better version of this test. Check the failure details — it may need a setup step or real credentials.");
  }
  return { endpointId, title, before, after };
};

/** Replace the reviewed test (pure). Its old result goes away until it is re-run. */
export const applyTestFix = (job: JobState, endpointId: string, title: string, fixed: GeneratedTestCase): JobState => {
  if (!job.generatedTests.some((test) => sameTest(test, endpointId, title))) {
    throw new Error('That test no longer exists — generate or reload, then try again.');
  }
  // Drop the old result now: the fixed test may be renamed, and a re-run only replaces results
  // by title — the stale failure would otherwise linger.
  const summary = job.validationSummary;
  const results = summary?.results.filter((result) => !sameTest(result, endpointId, title));
  const passed = results?.filter((result) => result.success).length ?? 0;
  return {
    ...job,
    generatedTests: job.generatedTests.map((test) => (sameTest(test, endpointId, title) ? fixed : test)),
    validationSummary: summary && results
      ? { ...summary, results, attempted: results.length, passed, failed: results.length - passed }
      : summary,
    updatedAt: Date.now()
  };
};
