import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lineDiff } from '@shared/lineDiff';
import { makeEndpoint, makeGeneratedTestCase, makeJobState, makeSettings, makeValidationResult, makeValidationSummary } from '@shared/testing/factories';

const repairMock = vi.fn();
vi.mock('@background/generation/testGenerator', () => ({ repairTestsFromValidation: (...args: unknown[]) => repairMock(...args) }));
const { applyTestFix, proposeTestFix } = await import('@background/fixes/testFix');

const endpoint = makeEndpoint({ id: 'GET::/users' });
const broken = makeGeneratedTestCase({ endpointId: endpoint.id, title: 'gets user 999', request: { method: 'GET', path: '/users/999' } });
const fixed = { ...broken, title: 'gets an existing user', request: { method: 'GET', path: '/users/{{USER_ID}}' } };
const jobWith = (verdict: 'test' | 'api') =>
  makeJobState({
    stage: 'complete',
    repo: { platform: 'github', owner: 'acme', repo: 'api' },
    endpoints: [endpoint],
    generatedTests: [broken],
    validationSummary: makeValidationSummary({
      attempted: 1, passed: 0, failed: 1,
      results: [makeValidationResult({ endpointId: endpoint.id, title: broken.title, success: false, status: verdict === 'api' ? 500 : 404, verdict })]
    })
  });

beforeEach(() => repairMock.mockReset());

describe('lineDiff', () => {
  it('marks removed and added lines around unchanged ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' }
    ]);
  });
});

describe('proposeTestFix', () => {
  it('asks the model about only that test and returns before/after for review', async () => {
    repairMock.mockResolvedValue([fixed]);
    const proposal = await proposeTestFix({ settings: makeSettings(), job: jobWith('test'), endpointId: endpoint.id, title: broken.title });
    expect(proposal).toEqual({ endpointId: endpoint.id, title: broken.title, before: broken, after: fixed });
    expect(repairMock.mock.calls[0][0].tests).toEqual([broken]);
  });

  it('refuses to "fix" a test that caught a likely API bug', async () => {
    await expect(proposeTestFix({ settings: makeSettings(), job: jobWith('api'), endpointId: endpoint.id, title: broken.title })).rejects.toThrow(/bug in the API/);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('refuses when the route does not exist on the API', async () => {
    const job = jobWith('test');
    job.validationSummary!.results[0] = { ...job.validationSummary!.results[0], verdict: 'missing' };
    await expect(proposeTestFix({ settings: makeSettings(), job, endpointId: endpoint.id, title: broken.title })).rejects.toThrow(/no such route/);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('says so when the model returns nothing better — bookkeeping-only changes do not count', async () => {
    repairMock.mockResolvedValue([{ ...broken, order: 50 }]);
    await expect(proposeTestFix({ settings: makeSettings(), job: jobWith('test'), endpointId: endpoint.id, title: broken.title })).rejects.toThrow(/couldn't find a better version/);
  });
});

describe('applyTestFix', () => {
  it('replaces the test and drops its stale result (the fix may be renamed)', () => {
    const next = applyTestFix(jobWith('test'), endpoint.id, broken.title, fixed);
    expect(next.generatedTests).toEqual([fixed]);
    expect(next.validationSummary).toMatchObject({ results: [], attempted: 0, failed: 0 });
  });
});
