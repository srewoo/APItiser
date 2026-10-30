import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';

const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// A local stand-in for an OpenAI-compatible provider so we can exercise the extension's REAL
// outbound provider-key check (service-worker → fetch) in a real browser, with no secrets and no
// paid calls. 127.0.0.1 is covered by the extension's host_permissions.
let providerServer: Server;
let providerBaseUrl: string;
let nextModelsStatus = 200;

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(distPath)) {
    throw new Error(`dist/ not found at ${distPath}. Run \`npm run build\` before the E2E suite.`);
  }

  const userDataDir = await mkdtemp(resolve(tmpdir(), 'apitiser-e2e-'));
  // Chrome only loads an unpacked MV3 extension from a persistent (headed) context.
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      '--no-sandbox'
    ]
  });

  // The MV3 service worker registers on load; its URL carries the extension id.
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  extensionId = new URL(sw.url()).host;
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test.beforeAll(async () => {
  providerServer = createServer((req, res) => {
    // The provider-key check hits GET <base>/v1/models. Return the status the current test wants.
    if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
      res.writeHead(nextModelsStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextModelsStatus === 200 ? { data: [{ id: 'gpt-5' }] } : { error: 'unauthorized' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => providerServer.listen(0, '127.0.0.1', r));
  const addr = providerServer.address();
  providerBaseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((r) => providerServer?.close(() => r()));
});

test('side panel renders and shows first-run onboarding on a fresh install', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // Hero always renders.
  await expect(page.getByRole('heading', { name: 'API Tests in Seconds' })).toBeVisible();

  // Fresh install has no provider key configured, so the setup checklist guides the user.
  await expect(page.getByRole('heading', { name: 'Get set up' })).toBeVisible();
  await expect(page.getByText('Add an LLM provider API key')).toBeVisible();

  await page.close();
});

test('settings save and restore through chrome.storage.local', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: 'API Tests in Seconds' })).toBeVisible();

  // Persist a setting the way the app does, then confirm it survives a reload.
  await page.evaluate(async () => {
    const state = await chrome.storage.local.get(null);
    const key = Object.keys(state).find((k) => k.startsWith('apitiser.state'));
    const bucket = key ? (state[key] as Record<string, unknown>) : {};
    const settings = (bucket.settings as Record<string, unknown>) ?? {};
    const record = { ...bucket, settings: { ...settings, batchSize: 11 } };
    await chrome.storage.local.set({ [key ?? 'apitiser.state.v1']: record });
  });

  await page.reload();
  const stored = await page.evaluate(async () => {
    const state = await chrome.storage.local.get(null);
    const key = Object.keys(state).find((k) => k.startsWith('apitiser.state'));
    const bucket = key ? (state[key] as { settings?: { batchSize?: number } }) : {};
    return bucket.settings?.batchSize;
  });
  expect(stored).toBe(11);

  await page.close();
});

// Read the persisted APItiser settings bucket from chrome.storage.local.
const readSettings = async (page: import('@playwright/test').Page): Promise<Record<string, unknown>> =>
  page.evaluate(async () => {
    const state = await chrome.storage.local.get(null);
    const key = Object.keys(state).find((k) => k.startsWith('apitiser.state'));
    const bucket = key ? (state[key] as Record<string, unknown>) : {};
    return (bucket.settings as Record<string, unknown>) ?? {};
  });

test('onboarding wizard walks every step and persists settings + completion', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/onboarding.html`);

  await expect(page.getByRole('heading', { name: 'Welcome to APItiser' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();

  // AI provider step.
  await expect(page.getByRole('heading', { name: 'AI provider & model' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Generation step — change the framework; the select persists on change.
  await expect(page.getByRole('heading', { name: 'Generation' })).toBeVisible();
  await page.getByRole('combobox').selectOption('pytest');
  await expect.poll(async () => (await readSettings(page)).framework).toBe('pytest');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Repository → Live validation → Local runs → All set.
  await expect(page.getByRole('heading', { name: 'Repository access' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Live validation' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Local runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  // Finish persists onboardingCompletedAt and then calls window.close(), so read it back from a
  // fresh page (chrome.storage.local persists across the context).
  await page.getByRole('button', { name: 'Finish' }).click({ noWaitAfter: true }).catch(() => {});

  const verifyPage = await context.newPage();
  await verifyPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect.poll(async () => (await readSettings(verifyPage)).onboardingCompletedAt).toBeTruthy();
  await verifyPage.close();
});

test('onboarding warns when the local repo path is the extension itself', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await page.getByRole('button', { name: 'Get started' }).click(); // provider
  await page.getByRole('button', { name: 'Continue' }).click(); // generation
  await page.getByRole('button', { name: 'Continue' }).click(); // repository
  await page.getByRole('button', { name: 'Continue' }).click(); // validation
  await page.getByRole('button', { name: 'Continue' }).click(); // local runs

  await expect(page.getByRole('heading', { name: 'Local runs' })).toBeVisible();
  const repoInput = page.getByPlaceholder('/Users/you/code/my-api');
  await repoInput.fill('/Users/me/projects/APItiser');
  await expect(page.getByText(/looks like the APItiser extension's own repo/)).toBeVisible();

  // A real API path clears the warning.
  await repoInput.fill('/Users/me/projects/my-real-api');
  await expect(page.getByText(/looks like the APItiser extension's own repo/)).toHaveCount(0);
  await page.close();
});

/** Pick "Other local server" in onboarding and point it at our stand-in (blur commits the URL). */
const chooseLocalServer = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByRole('heading', { name: 'AI provider & model' })).toBeVisible();
  await page.getByRole('combobox').first().selectOption('local');
  const serverUrl = page.getByPlaceholder('http://localhost:8000');
  await serverUrl.fill(providerBaseUrl);
  await serverUrl.blur();
  // Local mode: no API key field at all.
  await expect(page.getByPlaceholder(/^sk-/)).toHaveCount(0);
};

test('local LLM: no key, real call to the local server, and its model list is used', async () => {
  nextModelsStatus = 200;
  const page = await context.newPage();
  await chooseLocalServer(page);
  await page.getByRole('button', { name: 'Test connection & save' }).click();

  await expect(page.getByText(/Local model server is reachable/i)).toBeVisible();
  // The served model list was stored and the model switched to one the server actually has.
  await expect.poll(async () => (await readSettings(page)).model).toBe('gpt-5');
  await expect
    .poll(async () => ((await readSettings(page)).availableModels as Record<string, string[]> | undefined)?.local)
    .toEqual(['gpt-5']);
  expect((await readSettings(page)).openAiBaseUrl).toBe(providerBaseUrl);
  // The dropdown keeps showing the local choice after saving.
  await expect(page.getByRole('combobox').first()).toHaveValue('local');
  await page.close();
});

test('local LLM: a server that refuses access is reported, not saved as working', async () => {
  nextModelsStatus = 401;
  const page = await context.newPage();
  await chooseLocalServer(page);
  await page.getByRole('button', { name: 'Test connection & save' }).click();

  await expect(page.getByText(/local server refused the request \(HTTP 401\)/i)).toBeVisible();
  await page.close();
});
