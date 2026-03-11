import type { ExtensionSettings, LLMProvider } from './types';

export const STORAGE_KEY = 'apitiser.state.v1';
export const HEARTBEAT_ALARM = 'apitiser.keepalive';

export const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  openai: ['gpt-4o', 'gpt-4.1-mini'],
  claude: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro']
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: 'openai',
  model: PROVIDER_MODELS.openai[0],
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
