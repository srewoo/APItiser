import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Full stack, no fakes: Chrome → extension → native-messaging host → runLocal → a real app on a
// free port → tests fired from the extension → results in the panel. Needs the sibling runLocal
// checkout (../runLocal); skipped otherwise.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(root, 'dist');
const hostScript = resolve(root, 'native-host', 'apitiser-runner.mjs');
const runLocalScript = resolve(root, '..', 'runLocal', 'run-local.sh');
const HOST_NAME = 'com.apitiser.localrunner';

let context: BrowserContext;
let extensionId: string;
let repoPath: string;

test.skip(!existsSync(runLocalScript), `runLocal not found at ${runLocalScript}`);

test.beforeAll(async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'apitiser-svc-'));

  // A tiny API that honours PORT, plus a /crash route to kill it on demand.
  repoPath = resolve(work, 'sample-api');
  await mkdir(repoPath);
  await writeFile(
    resolve(repoPath, 'package.json'),
    JSON.stringify({ name: 'sample-api', version: '1.0.0', private: true, scripts: { start: 'node server.js' } })
  );
  await writeFile(
    resolve(repoPath, 'server.js'),
    `require('http').createServer((req, res) => {
      if (req.url === '/users') { res.writeHead(200, {'content-type':'application/json'}); return res.end('[{"id":1}]'); }
      if (req.url === '/crash') { res.end('bye'); return setTimeout(() => process.exit(3), 50); }
      res.writeHead(404); res.end('{}');
    }).listen(Number(process.env.PORT || 3000), () => console.log('listening on ' + (process.env.PORT || 3000)));`
  );

  const userDataDir = resolve(work, 'profile');
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, '--no-sandbox']
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(sw.url()).host;

  // Register the real host for THIS profile (Chromium reads <user-data-dir>/NativeMessagingHosts),
  // pinned to this extension id — the same thing install.sh does for a real browser.
  const launcher = resolve(work, 'host-launcher.sh');
  await writeFile(launcher, `#!/bin/bash\nexec "${process.execPath}" "${hostScript}" "$@"\n`);
  await chmod(launcher, 0o755);
  await mkdir(resolve(userDataDir, 'NativeMessagingHosts'), { recursive: true });
  await writeFile(
    resolve(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify({
      name: HOST_NAME,
      description: 'APItiser local runner (e2e)',
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    })
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
});

/** Seed settings + a generated suite for the panel's own tab context, then reload. */
const seed = async (page: Page): Promise<void> => {
  await page.bringToFront();
  await page.evaluate(
    async ({ repoPath, runLocalScript }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab.url ?? '');
      const contextId = `tab:${tab.id}|page:${url.origin}${url.pathname}`;
      const key = 'apitiser.state.v1';
      const existing = ((await chrome.storage.local.get(key))[key] ?? {}) as Record<string, unknown>;
      const endpoint = (method: string, path: string) => ({
        id: `${method}::${path}`, method, path, source: 'express', pathParams: [], queryParams: [], responses: [], confidence: 1
      });
      await chrome.storage.local.set({
        [key]: {
          settings: {
            ...(existing.settings as Record<string, unknown>),
            openAiKey: 'sk-test',
            baseUrl: '',
            enableLocalRunner: true,
            localRepoPath: repoPath,
            localRunPort: 0, // auto
            runLocalScriptPath: runLocalScript,
            retryOnRateLimit: false
          },
          contexts: {
            [contextId]: {
              activeJob: null,
              artifacts: [],
              metricsHistory: [],
              jobHistory: [{
                jobId: 'seeded', stage: 'complete', startedAt: 0, updatedAt: 0, progress: 100, statusText: 'Generated',
                totalEndpoints: 1, completedBatches: 1, totalBatches: 1,
                endpoints: [endpoint('GET', '/users')],
                generatedTests: [{
                  endpointId: 'GET::/users', category: 'positive', title: 'lists users',
                  request: { method: 'GET', path: '/users' }, expected: { status: 200, contains: ['"id"'] }
                }]
              }]
            }
          }
        }
      });
    },
    { repoPath, runLocalScript }
  );
  await page.reload();
};

test('starts the repo on a free port via the native host, runs an endpoint, and tracks the service', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seed(page);

  const panel = page.locator('.live-run');
  await panel.getByRole('button', { name: 'Start' }).click();
  await expect(panel.getByText('Local service: Running')).toBeVisible({ timeout: 60_000 });

  // Auto port: a real free port, not 3000/8000/8080.
  const target = await panel.locator('p', { hasText: 'Target:' }).locator('code').innerText();
  const port = Number(new URL(target).port);
  expect(target).toMatch(/^http:\/\/localhost:\d+$/);
  expect([3000, 8000, 8080]).not.toContain(port);

  // Run the endpoint against the booted app and see the live result.
  await page.getByRole('button', { name: 'Run tests for GET /users' }).click();
  await expect(page.locator('.results-panel').getByText('1/1 passed')).toBeVisible({ timeout: 30_000 });

  // Crash the app out-of-band: the panel must stop claiming it is running.
  await page.evaluate((url) => fetch(`${url}/crash`).catch(() => undefined), target);
  await expect(panel.getByText('Local service: Failed')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(/stopped unexpectedly/)).toBeVisible();

  // Start again, then Stop: the port must actually be released.
  await panel.getByRole('button', { name: 'Start' }).click();
  await expect(panel.getByText('Local service: Running')).toBeVisible({ timeout: 60_000 });
  const second = await panel.locator('p', { hasText: 'Target:' }).locator('code').innerText();
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(panel.getByText('Local service: Stopped')).toBeVisible();
  await expect
    .poll(async () => page.evaluate((url) => fetch(url).then(() => 'open', () => 'closed'), second), { timeout: 10_000 })
    .toBe('closed');

  await page.close();
});
