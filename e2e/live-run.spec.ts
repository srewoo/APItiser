import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';

// Real-browser check of "run one endpoint's tests and see the results": a real local HTTP API,
// a seeded generated suite, a click on the endpoint's ▶ button, and the live results panel.

const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

let context: BrowserContext;
let extensionId: string;
let api: Server;
let apiBase: string;

test.beforeAll(async () => {
  api = createServer((req, res) => {
    if (req.url === '/users') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Ada' }]));
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const addr = api.address();
  apiBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const userDataDir = await mkdtemp(resolve(tmpdir(), 'apitiser-live-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`, '--no-sandbox']
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(sw.url()).host;

  // A fresh install opens the onboarding tab, which would steal "active tab" (the panel keys its
  // state by the active tab). Close it so the test page owns the context.
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
  await new Promise<void>((r) => api?.close(() => r()));
});

const endpoint = (method: string, path: string) => ({
  id: `${method}::${path}`,
  method,
  path,
  source: 'express',
  pathParams: [],
  queryParams: [],
  responses: [],
  confidence: 1
});

const test200 = (path: string, title: string, contains?: string[]) => ({
  endpointId: `GET::${path}`,
  category: 'positive',
  title,
  request: { method: 'GET', path },
  expected: { status: 200, contains }
});

/** Seed a completed job for the side panel's own tab context, then reload so it renders. */
const seed = async (page: Page, baseUrl: string): Promise<void> => {
  await page.bringToFront();
  await page.evaluate(
    async ({ baseUrl, job }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = new URL(tab.url ?? '');
      const contextId = `tab:${tab.id}|page:${url.origin}${url.pathname}`;
      const key = 'apitiser.state.v1';
      const existing = ((await chrome.storage.local.get(key))[key] ?? {}) as Record<string, unknown>;
      const settings = { ...(existing.settings as Record<string, unknown>), baseUrl, retryOnRateLimit: false, openAiKey: 'sk-test' };
      await chrome.storage.local.set({
        [key]: {
          settings,
          contexts: { [contextId]: { activeJob: null, jobHistory: [job], artifacts: [], metricsHistory: [] } }
        }
      });
    },
    {
      baseUrl,
      job: {
        jobId: 'seeded',
        stage: 'complete',
        startedAt: 0,
        updatedAt: 0,
        progress: 100,
        statusText: 'Generated',
        totalEndpoints: 2,
        completedBatches: 1,
        totalBatches: 1,
        endpoints: [endpoint('GET', '/users'), endpoint('GET', '/orders')],
        generatedTests: [
          test200('/users', 'lists users'),
          test200('/users', 'mentions Grace', ['Grace']),
          test200('/orders', 'lists orders')
        ]
      }
    }
  );
  await page.reload();
};

test('runs one endpoint in the browser and shows per-test results', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seed(page, apiBase);

  await expect(page.getByRole('heading', { name: 'Run in Browser' })).toBeVisible();
  await page.getByRole('button', { name: 'Run tests for GET /users' }).click();

  const results = page.locator('.results-panel');
  const groups = results.locator('.result-group > summary code');
  await expect(results.getByText('1/2 passed')).toBeVisible();
  await expect(groups).toHaveText(['GET /users']);
  await expect(results.getByText('Response did not contain "Grace".')).toBeVisible();
  // Only the clicked endpoint ran (asserted by the single group above).

  // Run everything: /orders now shows up as failing, /users results are replaced, not duplicated.
  await page.getByRole('button', { name: '▶ Run all tests' }).click();
  await expect(results.getByText('1/3 passed')).toBeVisible();
  await expect(groups).toHaveText(['GET /users', 'GET /orders']);
  await expect(results.getByText('Expected HTTP 200 but received 500.')).toBeVisible();

  await page.close();
});

test('blocks live runs against a non-local Base URL', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seed(page, 'https://api.example.com');

  await expect(page.getByRole('alert').filter({ hasText: 'not a local address' })).toBeVisible();
  await expect(page.getByRole('button', { name: '▶ Run all tests' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run tests for GET /users' })).toBeDisabled();

  await page.close();
});

test('says clearly when nothing is running at the Base URL (instead of N "Failed to fetch" failures)', async () => {
  // A port that was free a moment ago and has nothing listening on it.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  const deadPort = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((r) => probe.close(() => r()));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seed(page, `http://127.0.0.1:${deadPort}`);

  await page.getByRole('button', { name: '▶ Run all tests' }).click();
  const results = page.locator('.results-panel');
  await expect(results.getByText(/Couldn't reach http:\/\/127\.0\.0\.1:\d+ — nothing answered/)).toBeVisible();
  await expect(results.getByText('0/0 passed')).toBeVisible();
  // No per-test "Failed to fetch" noise.
  await expect(page.getByText('Failed to fetch')).toHaveCount(0);
  await expect(results.locator('.result-group')).toHaveCount(0);
  await page.close();
});
