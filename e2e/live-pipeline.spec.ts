/**
 * OPT-IN real pipeline E2E: loads the built extension in real Chromium and drives a genuine
 * scan → generate against a PUBLIC GitHub repo using a REAL LLM provider key. It makes real,
 * paid API calls, so it is skipped unless the required env vars are set (never runs in CI by
 * default). Secrets are read from process.env or a git-ignored `.env.e2e` at the repo root.
 *
 * Required:
 *   APITISER_E2E_REPO=owner/repo            (a small PUBLIC repo with detectable endpoints)
 *   one of:
 *     APITISER_E2E_OPENAI_KEY=sk-...
 *     APITISER_E2E_CLAUDE_KEY=sk-ant-...
 *     APITISER_E2E_GEMINI_KEY=AIza...
 * Optional:
 *   APITISER_E2E_MODEL=<model id>           (defaults to the provider's newest)
 *   APITISER_E2E_GITHUB_TOKEN=ghp_...       (avoids the 60/hr unauthenticated rate limit)
 *   APITISER_E2E_BASE_URL=http://localhost:8080  (if set, also runs live validation)
 *
 * Run: npx playwright test e2e/live-pipeline.spec.ts
 */
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(repoRoot, 'dist');

// Load a git-ignored .env.e2e (KEY=VALUE lines) into process.env, without adding a dotenv dep.
const envFile = resolve(repoRoot, '.env.e2e');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

type Provider = 'openai' | 'claude' | 'gemini';
const resolveProvider = (): { provider: Provider; key: string } | null => {
  if (process.env.APITISER_E2E_OPENAI_KEY) return { provider: 'openai', key: process.env.APITISER_E2E_OPENAI_KEY };
  if (process.env.APITISER_E2E_CLAUDE_KEY) return { provider: 'claude', key: process.env.APITISER_E2E_CLAUDE_KEY };
  if (process.env.APITISER_E2E_GEMINI_KEY) return { provider: 'gemini', key: process.env.APITISER_E2E_GEMINI_KEY };
  return null;
};

const llm = resolveProvider();
// Accept either "owner/repo" or a full GitHub URL (https://github.com/owner/repo[.git]).
const parseRepo = (raw: string): { owner: string; repo: string } => {
  const s = raw.trim().replace(/\.git$/, '');
  const url = /github\.com[/:]([^/]+)\/([^/\s]+)/.exec(s);
  if (url) return { owner: url[1], repo: url[2] };
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? { owner: parts[parts.length - 2], repo: parts[parts.length - 1] } : { owner: '', repo: '' };
};
const { owner: repoOwner, repo: repoName } = parseRepo(process.env.APITISER_E2E_REPO ?? '');
const repoSlug = `${repoOwner}/${repoName}`;
const missing = !llm || !repoOwner || !repoName;

// A real LLM call over a scanned repo can take a while — give it room.
test.describe.configure({ timeout: 300_000 });

const PROVIDER_KEY_FIELD: Record<Provider, string> = {
  openai: 'openAiKey',
  claude: 'claudeKey',
  gemini: 'geminiKey'
};

const cmd = <T = unknown>(page: Page, message: unknown): Promise<T> =>
  page.evaluate((m) => chrome.runtime.sendMessage(m) as Promise<unknown>, message) as Promise<T>;

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  test.skip(missing, 'Set APITISER_E2E_REPO and an APITISER_E2E_{OPENAI,CLAUDE,GEMINI}_KEY to run the live pipeline E2E.');
  if (!existsSync(distPath)) throw new Error(`dist/ not found. Run \`npm run build\` first.`);

  const userDataDir = await mkdtemp(resolve(tmpdir(), 'apitiser-live-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, '--no-sandbox']
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test('real scan + generate against a public repo with a real LLM', async () => {
  test.skip(missing, 'live pipeline env not configured');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: 'API Tests in Seconds' })).toBeVisible();

  const baseUrl = process.env.APITISER_E2E_BASE_URL;
  // Configure the run: real provider key, tiny batches, one category to keep it cheap/fast.
  await cmd(page, {
    type: 'SAVE_SETTINGS',
    payload: {
      provider: llm!.provider,
      ...(process.env.APITISER_E2E_MODEL ? { model: process.env.APITISER_E2E_MODEL } : {}),
      [PROVIDER_KEY_FIELD[llm!.provider]]: llm!.key,
      ...(process.env.APITISER_E2E_GITHUB_TOKEN ? { githubToken: process.env.APITISER_E2E_GITHUB_TOKEN } : {}),
      framework: 'jest',
      includeCategories: ['positive'],
      skipExistingTests: false,
      batchSize: 2,
      validateGeneratedTests: Boolean(baseUrl),
      autoRepairFailingTests: false,
      ...(baseUrl ? { baseUrl } : {})
    }
  });

  // 1) Real scan of the public repo (GitHub API).
  const repo = { platform: 'github' as const, owner: repoOwner, repo: repoName };
  await cmd(page, { type: 'START_SCAN', payload: { repo } });

  const afterScan = await cmd<{ payload: { activeJob?: { endpoints?: unknown[] }; jobHistory?: Array<{ endpoints?: unknown[] }> } }>(
    page,
    { type: 'GET_STATE' }
  );
  const scannedEndpoints =
    afterScan.payload.activeJob?.endpoints ?? afterScan.payload.jobHistory?.[0]?.endpoints ?? [];
  console.log(`[live-e2e] scanned ${repoSlug}: ${scannedEndpoints.length} endpoints detected`);
  expect(scannedEndpoints.length).toBeGreaterThan(0);

  // 2) Real generation for a couple of endpoints (bounded to keep cost/time low).
  const ids = (scannedEndpoints as Array<{ id: string }>).slice(0, 2).map((e) => e.id);
  await cmd(page, { type: 'START_GENERATION', payload: { selectedEndpointIds: ids } });

  const afterGen = await cmd<{
    payload: {
      activeJob?: { generatedTests?: unknown[]; stage?: string };
      jobHistory?: Array<{ generatedTests?: unknown[] }>;
      artifacts?: unknown[];
    };
  }>(page, { type: 'GET_STATE' });
  const tests =
    afterGen.payload.activeJob?.generatedTests ?? afterGen.payload.jobHistory?.[0]?.generatedTests ?? [];
  console.log(`[live-e2e] generated ${tests.length} tests; artifacts=${afterGen.payload.artifacts?.length ?? 0}`);
  expect(tests.length).toBeGreaterThan(0);

  // 3) An artifact should be packaged and downloadable.
  expect((afterGen.payload.artifacts?.length ?? 0)).toBeGreaterThan(0);

  await page.close();
});
