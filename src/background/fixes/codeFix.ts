/**
 * "Propose a code fix" for a likely API bug: show the model the failing request/response and the
 * source files the scan tied to that endpoint, and ask for minimal, exact find/replace edits.
 * The proposal is only a suggestion — the user reviews every diff before anything is written.
 */
import type { ApiEndpoint, CodeEdit, CodeFixProposal, ExtensionSettings, GeneratedTestCase, JobState, ValidationResult } from '@shared/types';
import { providerKeyFor } from '@shared/localLlm';
import { loadProviderAdapter } from '../llm/client';

export interface RepoFileContent {
  path: string;
  content: string;
  truncated: boolean;
}


const SYSTEM_PROMPT =
  'You are a senior backend engineer fixing a bug in an HTTP API. You change application code, never tests. ' +
  'You make the smallest correct change and reply with a single JSON object only.';

// Spec files describe the API; the handler code lives elsewhere.
const isSpecFile = (file: string) => /\.(ya?ml|json|graphql|gql|proto)$/i.test(file);

/** Source files the scan tied to this endpoint (repo-relative). */
export const endpointSourceFiles = (endpoint: ApiEndpoint): string[] =>
  [...new Set((endpoint.evidence ?? []).map((item) => item.filePath).filter((file) => file && !isSpecFile(file)))];

const numbered = (content: string) =>
  content
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4)} | ${line}`)
    .join('\n');

export const buildCodeFixPrompt = (input: {
  endpoint: ApiEndpoint;
  test: GeneratedTestCase;
  result: ValidationResult;
  files: RepoFileContent[];
}): string => {
  const { endpoint, test, result, files } = input;
  return [
    `A live API test failed and it looks like a bug in the API, not in the test.`,
    `Endpoint: ${endpoint.method} ${endpoint.path}`,
    `Why it looks like an API bug: ${result.verdictReason ?? 'n/a'}`,
    `Test (what a correct API should do): ${JSON.stringify({ title: test.title, category: test.category, request: test.request, expected: test.expected })}`,
    `Actual response: HTTP ${result.status ?? '?'} — ${result.responseSnippet ?? '(empty body)'}`,
    `Failures: ${result.failures.map((failure) => failure.message).join(' | ')}`,
    '',
    'Source files (line numbers are for reference only — never include them in edits):',
    ...files.map((file) => `--- ${file.path}${file.truncated ? ' (truncated)' : ''} ---\n${numbered(file.content)}`),
    '',
    'Reply with JSON exactly like:',
    '{"explanation": "<one or two sentences: the root cause and the fix>", "edits": [{"path": "<one of the file paths above>", "find": "<exact text copied from that file>", "replace": "<new text>"}]}',
    'Rules:',
    '- Fix the root cause in the application code. Do not weaken validation, auth, or error handling to make the test pass.',
    '- "find" must be copied character-for-character from the file (no line numbers), and must appear exactly once — include enough surrounding lines to be unique.',
    '- Keep edits minimal; only touch the files listed above.',
    '- If the bug is not in these files or you are not confident, return {"explanation": "<why>", "edits": []}.'
  ].join('\n');
};

const firstJsonObject = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [text, fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate?.trim()) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
};

/** Parse the model's reply; keep only well-formed edits to files it was shown. */
export const parseCodeFix = (text: string, allowedFiles: string[]): { explanation: string; edits: CodeEdit[] } => {
  const json = firstJsonObject(text) as { explanation?: unknown; edits?: unknown } | undefined;
  if (!json || typeof json !== 'object') throw new Error('The model did not return a usable fix.');
  const allowed = new Set(allowedFiles);
  const edits = (Array.isArray(json.edits) ? json.edits : [])
    .filter((edit): edit is CodeEdit =>
      Boolean(edit) &&
      typeof edit.path === 'string' &&
      typeof edit.find === 'string' &&
      typeof edit.replace === 'string' &&
      edit.find.length > 0 &&
      edit.find !== edit.replace &&
      allowed.has(edit.path)
    )
    .map(({ path, find, replace }) => ({ path, find, replace }));
  return { explanation: typeof json.explanation === 'string' ? json.explanation : '', edits };
};

export const proposeCodeFix = async (options: {
  settings: ExtensionSettings;
  job: JobState;
  endpointId: string;
  title: string;
  root: string;
  readFiles: (root: string, paths: string[]) => Promise<RepoFileContent[]>;
  signal?: AbortSignal;
}): Promise<CodeFixProposal> => {
  const { settings, job, endpointId, title, root } = options;
  const test = job.generatedTests.find((item) => item.endpointId === endpointId && item.title === title);
  const result = job.validationSummary?.results.find((item) => item.endpointId === endpointId && item.title === title);
  const endpoint = job.endpoints.find((item) => item.id === endpointId);
  if (!test || !result || !endpoint || !job.repo) throw new Error('Run this test first — there is no failure to fix yet.');
  if (result.verdict !== 'api') {
    throw new Error("This failure is the test's fault, not the API's — use “Fix this test” instead.");
  }
  const paths = endpointSourceFiles(endpoint);
  if (!paths.length) {
    throw new Error("The scan didn't record which source file handles this endpoint, so there's nothing to fix safely.");
  }
  const files = await options.readFiles(root, paths);
  if (!files.length) throw new Error(`Couldn't read ${paths.join(', ')} under ${root} — is that the right folder for this repo?`);

  const provider = settings.provider;
  const apiKey = providerKeyFor(settings, provider);
  if (!apiKey) throw new Error(`Add a ${provider} API key (or pick a local model) in Settings to propose code fixes.`);
  const adapter = await loadProviderAdapter(provider);
  const reply = await adapter.generateTests(
    [endpoint],
    { repo: job.repo, framework: settings.framework, includeCategories: settings.includeCategories, timeoutMs: settings.timeoutMs },
    {
      apiKey,
      model: settings.model,
      baseUrl: provider === 'openai' ? settings.openAiBaseUrl : undefined,
      temperature: settings.temperature,
      signal: options.signal,
      timeoutMs: settings.timeoutMs,
      hardTimeoutMs: settings.timeoutMs * 2,
      promptOverride: buildCodeFixPrompt({ endpoint, test, result, files }),
      systemOverride: SYSTEM_PROMPT,
      rawOutput: true
    }
  );
  const shown = files.map((file) => file.path);
  const { explanation, edits } = parseCodeFix(reply.rawText ?? '', shown);
  if (!edits.length) {
    throw new Error(`No safe code fix proposed${explanation ? `: ${explanation}` : '.'}`);
  }
  return { endpointId, title, root, explanation, edits, files: shown };
};
