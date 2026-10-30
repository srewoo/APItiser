import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';

// The whole failure loop in real Chrome, no extension internals faked: native host + runLocal boot
// a small API with a real bug; a stand-in local LLM (OpenAI-compatible, on 127.0.0.1) returns a
// corrected test or a code fix. We check triage, the reviewed test fix, the reviewed code fix
// (file really edited, API restarted, test now passes) and Undo.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(root, 'dist');
const hostScript = resolve(root, 'native-host', 'apitiser-runner.mjs');
const runLocalScript = resolve(root, '..', 'runLocal', 'run-local.sh');
const HOST_NAME = 'com.apitiser.localrunner';

const BUGGY_LINE = '    const user = users[id]; const body = JSON.stringify({ id, name: user.name }); res.writeHead(200, {"content-type":"application/json"}); return res.end(body);';
const FIXED_LINE = '    const user = users[id]; if (!user) { res.writeHead(404, {"content-type":"application/json"}); return res.end(\'{"error":"not found"}\'); } const body = JSON.stringify({ id, name: user.name }); res.writeHead(200, {"content-type":"application/json"}); return res.end(body);';

let context: BrowserContext;
let extensionId: string;
let repoPath: string;
let llm: Server;
let llmUrl: string;

test.skip(!existsSync(runLocalScript), `runLocal not found at ${runLocalScript}`);

test.beforeAll(async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'apitiser-fix-'));
  repoPath = resolve(work, 'sample-api');
  await mkdir(repoPath);
  await writeFile(resolve(repoPath, 'package.json'), JSON.stringify({ name: 'sample-api', private: true, scripts: { start: 'node server.js' } }));
  await writeFile(
    resolve(repoPath, 'server.js'),
    [
      "const users = { '1': { name: 'Ada' } };",
      "require('http').createServer((req, res) => {",
      // A crash-the-process bug, for the "API crashed mid-run" check.
      "  if (req.url === '/explode') { setImmediate(() => { throw new Error('boom'); }); return; }",
      // Like most frameworks: an unhandled error becomes a 500 (the process stays up).
      '  try {',
      "  const m = /^\\/users\\/(\\w+)$/.exec(req.url);",
      '  if (m) {',
      '    const id = m[1];',
      // BUG: an unknown id throws (user is undefined) → 500 instead of 404.
      BUGGY_LINE,
      '  }',
      "  res.writeHead(404); res.end('{}');",
      "  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }",
      "}).listen(Number(process.env.PORT), () => console.log('listening on ' + process.env.PORT));"
    ].join('\n')
  );

  // Stand-in local LLM: a code-fix request gets the fix; a test-repair request gets a corrected test.
  llm = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-coder' }] }));
        return;
      }
      const system: string = JSON.parse(body).messages[0].content;
      const content = system.includes('never tests')
        ? JSON.stringify({ explanation: 'Unknown ids crash on user.name; return 404 instead.', edits: [{ path: 'server.js', find: BUGGY_LINE, replace: FIXED_LINE }] })
        : JSON.stringify({
            tests: [{
              endpointId: 'GET::/users/{id}',
              category: 'positive',
              title: 'gets user 1 by id',
              request: { method: 'GET', path: '/users/1' },
              expected: { status: 200, contains: ['Ada'] }
            }]
          });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const addr = llm.address();
  llmUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const userDataDir = resolve(work, 'profile');
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, '--no-sandbox']
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(sw.url()).host;

  const launcher = resolve(work, 'host-launcher.sh');
  await writeFile(launcher, `#!/bin/bash\nexec "${process.execPath}" "${hostScript}" "$@"\n`);
  await chmod(launcher, 0o755);
  await mkdir(resolve(userDataDir, 'NativeMessagingHosts'), { recursive: true });
  await writeFile(
    resolve(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify({ name: HOST_NAME, description: 'e2e', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] })
  );
  // The install-time onboarding tab steals "active tab" from the panel. It can open before or
  // after this point (and may still be about:blank for a moment), so poll rather than wait once.
  for (let i = 0; i < 60; i += 1) {
    const onboarding = context.pages().find((p) => p.url().includes('onboarding.html'));
    if (onboarding) {
      await onboarding.close();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((r) => llm?.close(() => r()));
});

type SeedTest = { category: string; title: string; path: string; expected: Record<string, unknown> };
const DEFAULT_TESTS: SeedTest[] = [
  { category: 'negative', title: 'unknown user is 404', path: '/users/999', expected: { status: 404 } },
  { category: 'positive', title: 'gets user 1', path: '/users/1', expected: { status: 200, contains: ['Grace'] } }
];

const seed = async (page: Page, tests: SeedTest[] = DEFAULT_TESTS): Promise<void> => {
  await page.bringToFront();
  await page.evaluate(
    async ({ repoPath, runLocalScript, llmUrl, tests }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab.url ?? '');
      const contextId = `tab:${tab.id}|page:${url.origin}${url.pathname}`;
      const key = 'apitiser.state.v1';
      const existing = ((await chrome.storage.local.get(key))[key] ?? {}) as Record<string, unknown>;
      const endpoint = {
        id: 'GET::/users/{id}', method: 'GET', path: '/users/{id}', source: 'express',
        pathParams: [{ name: 'id', required: true, type: 'string' }], queryParams: [], responses: [], confidence: 1,
        evidence: [{ filePath: 'server.js', reason: 'route' }]
      };
      await chrome.storage.local.set({
        [key]: {
          settings: {
            ...(existing.settings as Record<string, unknown>),
            provider: 'openai', openAiBaseUrl: llmUrl, model: 'fake-coder', openAiKey: '',
            baseUrl: '', localRunPort: 0, runLocalScriptPath: runLocalScript, retryOnRateLimit: false,
            repoPaths: { 'github.com/e2e/sample-api': repoPath }
          },
          contexts: {
            [contextId]: {
              activeJob: null, artifacts: [], metricsHistory: [],
              jobHistory: [{
                jobId: 'seeded', stage: 'complete', startedAt: 0, updatedAt: 0, progress: 100, statusText: 'Generated',
                repo: { platform: 'github', owner: 'e2e', repo: 'sample-api' },
                totalEndpoints: 1, completedBatches: 1, totalBatches: 1, endpoints: [endpoint],
                generatedTests: tests.map((t) => ({ endpointId: endpoint.id, category: t.category, title: t.title, request: { method: 'GET', path: t.path }, expected: t.expected }))
              }]
            }
          }
        }
      });
    },
    { repoPath, runLocalScript, llmUrl, tests }
  );
  await page.reload();
};

test('triage → reviewed test fix → reviewed code fix (edits, restarts, passes) → undo', async () => {
  test.setTimeout(180_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seed(page);

  const panel = page.locator('.live-run');
  const results = page.locator('.results-panel');
  await panel.getByRole('button', { name: 'Start' }).click();
  await expect(panel.getByText('Local service: Running')).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/your chosen folder/)).toBeVisible();

  // 1. Triage: the 500 is the API's fault; the wrong "Grace" expectation is the test's.
  await page.getByRole('button', { name: '▶ Run all tests' }).click();
  await expect(results.getByText('1 likely API bug')).toBeVisible({ timeout: 30_000 });
  await expect(results.getByText('1 test need fixing')).toBeVisible();

  // 2. Fix the test: review the diff, accept → it re-runs and passes.
  await results.getByRole('button', { name: 'Fix this test…' }).click();
  const review = page.getByRole('dialog');
  await expect(review.locator('.diff-add', { hasText: 'Ada' }).first()).toBeVisible({ timeout: 30_000 });
  await review.getByRole('button', { name: 'Accept and re-run' }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(results.getByText('gets user 1 by id')).toBeVisible({ timeout: 30_000 });
  await expect(results.getByText('1 test need fixing')).toHaveCount(0);

  // 3. Fix the code: review, apply → file edited, API restarted, the bug's test passes.
  await results.getByRole('button', { name: 'Propose a code fix…' }).click();
  await expect(review.getByText('Unknown ids crash on user.name; return 404 instead.')).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText(/Originals are backed up/)).toBeVisible();
  expect(readFileSync(resolve(repoPath, 'server.js'), 'utf8')).toContain(BUGGY_LINE); // nothing written before Apply
  await review.getByRole('button', { name: 'Apply to my code and re-run' }).click();
  await expect(review).toBeHidden({ timeout: 90_000 });
  expect(readFileSync(resolve(repoPath, 'server.js'), 'utf8')).toContain(FIXED_LINE);
  await expect(results.getByText(/Code fix applied to/)).toBeVisible();
  await expect(results.getByText('2/2 passed')).toBeVisible({ timeout: 60_000 });

  // 4. Undo: original file back, API restarted, the bug is caught again.
  await results.getByRole('button', { name: 'Undo' }).click();
  await expect(results.getByText('1 likely API bug')).toBeVisible({ timeout: 90_000 });
  expect(readFileSync(resolve(repoPath, 'server.js'), 'utf8')).toContain(BUGGY_LINE);
  await expect(results.getByText(/Code fix applied to/)).toHaveCount(0);

  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(panel.getByText('Local service: Stopped')).toBeVisible();
  await page.close();
});

test('an API that crashes mid-run is reported as a crash, not "could not reach"', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seed(page, [{ category: 'positive', title: 'explodes', path: '/explode', expected: { status: 200 } }]);

  const panel = page.locator('.live-run');
  await panel.getByRole('button', { name: 'Start' }).click();
  await expect(panel.getByText('Local service: Running')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '▶ Run all tests' }).click();

  await expect(page.locator('.results-panel').getByText(/The API crashed during this run/)).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('Local service: Failed')).toBeVisible();
  await page.close();
});
