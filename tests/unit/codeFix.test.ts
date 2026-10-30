import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEndpoint, makeGeneratedTestCase, makeJobState, makeSettings, makeValidationResult, makeValidationSummary } from '@shared/testing/factories';

const generateTests = vi.fn();
vi.mock('@background/llm/client', () => ({ loadProviderAdapter: async () => ({ provider: 'openai', generateTests }) }));
const { endpointSourceFiles, parseCodeFix, proposeCodeFix } = await import('@background/fixes/codeFix');

const endpoint = makeEndpoint({
  id: 'GET::/users/{id}',
  evidence: [
    { filePath: 'api/users.py', reason: 'route' },
    { filePath: 'docs/openapi.yaml', reason: 'spec' }
  ]
});
const test = makeGeneratedTestCase({ endpointId: endpoint.id, title: 'unknown user is 404', category: 'negative', expected: { status: 404 } });
const jobWith = (verdict: 'api' | 'test') =>
  makeJobState({
    stage: 'complete',
    repo: { platform: 'github', owner: 'acme', repo: 'api' },
    endpoints: [endpoint],
    generatedTests: [test],
    validationSummary: makeValidationSummary({
      results: [makeValidationResult({ endpointId: endpoint.id, title: test.title, success: false, status: 500, verdict, verdictReason: 'The server errored (HTTP 500).' })]
    })
  });
const readFiles = vi.fn(async () => [{ path: 'api/users.py', content: 'return db[id]\n', truncated: false }]);
const settings = makeSettings({ provider: 'openai', openAiKey: 'sk-test' });

beforeEach(() => {
  generateTests.mockReset();
  readFiles.mockClear();
});

describe('endpointSourceFiles', () => {
  it('uses the handler code, not spec files', () => {
    expect(endpointSourceFiles(endpoint)).toEqual(['api/users.py']);
  });
});

describe('parseCodeFix', () => {
  it('keeps well-formed edits to files the model was shown, from fenced or bare JSON', () => {
    const reply = 'Here you go:\n```json\n{"explanation":"missing 404","edits":[{"path":"api/users.py","find":"return db[id]","replace":"return db.get(id) or not_found()"},{"path":"api/other.py","find":"a","replace":"b"},{"path":"api/users.py","find":"","replace":"x"}]}\n```';
    expect(parseCodeFix(reply, ['api/users.py'])).toEqual({
      explanation: 'missing 404',
      edits: [{ path: 'api/users.py', find: 'return db[id]', replace: 'return db.get(id) or not_found()' }]
    });
  });

  it('rejects replies that are not JSON', () => {
    expect(() => parseCodeFix('I think you should add a check.', ['a'])).toThrow(/usable fix/);
  });
});

describe('proposeCodeFix', () => {
  it('sends the failure and source to the model as a raw, non-test request and returns the edits', async () => {
    generateTests.mockResolvedValue({ tests: [], rawText: '{"explanation":"return 404 for unknown ids","edits":[{"path":"api/users.py","find":"return db[id]","replace":"return db.get(id)"}]}' });
    const proposal = await proposeCodeFix({ settings, job: jobWith('api'), endpointId: endpoint.id, title: test.title, root: '/repo', readFiles });
    expect(readFiles).toHaveBeenCalledWith('/repo', ['api/users.py']);
    const options = generateTests.mock.calls[0][2];
    expect(options).toMatchObject({ rawOutput: true });
    expect(options.systemOverride).toContain('never tests');
    expect(options.promptOverride).toContain('HTTP 500');
    expect(options.promptOverride).toContain('   1 | return db[id]');
    expect(proposal).toMatchObject({ root: '/repo', files: ['api/users.py'], explanation: 'return 404 for unknown ids' });
  });

  it("refuses when the failure is the test's fault", async () => {
    await expect(proposeCodeFix({ settings, job: jobWith('test'), endpointId: endpoint.id, title: test.title, root: '/repo', readFiles })).rejects.toThrow(/Fix this test/);
    expect(generateTests).not.toHaveBeenCalled();
  });

  it('reports when the model declines', async () => {
    generateTests.mockResolvedValue({ tests: [], rawText: '{"explanation":"the bug is in the database layer, not shown","edits":[]}' });
    await expect(proposeCodeFix({ settings, job: jobWith('api'), endpointId: endpoint.id, title: test.title, root: '/repo', readFiles })).rejects.toThrow(/No safe code fix proposed: the bug is in the database layer/);
  });
});
