import type { ExtensionSettings, LLMProvider } from './types';

export const STORAGE_KEY = 'apitiser.state.v1';
export const HEARTBEAT_ALARM = 'apitiser.keepalive';

export const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  // Latest first. Entries matching the reasoning patterns in modelCapabilities.ts
  // (OpenAI o-series/gpt-5, Claude 4.x/Fable) have temperature omitted automatically.
  openai: ['gpt-5', 'gpt-5-mini', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
  claude: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-7', 'claude-fable-5'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro']
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: 'openai',
  model: PROVIDER_MODELS.openai[0],
  temperature: 0.2,
  framework: 'jest',
  includeCategories: ['positive', 'negative', 'edge'],
  testDirectories: ['tests', '__tests__', 'test'],
  skipExistingTests: true,
  openApiFallbackSpec: '',
  batchSize: 6,
  timeoutMs: 5 * 60 * 1000,
  gitlabBaseUrl: 'https://gitlab.com',
  validateGeneratedTests: true,
  autoRepairFailingTests: true,
  maxValidationRepairs: 2,
  csrfHeaderName: 'X-CSRF-Token',
  apiKeyHeaderName: 'X-API-Key',
  runtimeApiToken: '',
  runtimeApiKey: '',
  runtimeCsrfToken: '',
  runtimeSessionCookie: '',
  runtimeAuthMode: 'none',
  runtimeSetupSteps: []
};
