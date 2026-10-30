/**
 * Local LLMs (Ollama, LM Studio, vLLM, …) speak the OpenAI API, so they run through the OpenAI
 * adapter with a loopback base URL. They need no API key, and nothing leaves the machine.
 */
import type { ExtensionSettings, LLMProvider } from './types';
import { DEFAULT_OPENAI_BASE_URL, PROVIDER_MODELS } from './constants';
import { isLoopbackUrl } from './localUrl';

export interface LocalLlmPreset {
  id: 'ollama' | 'lmstudio' | 'local';
  label: string;
  baseUrl: string;
  /** Suggested default; the user can type any model their server has loaded. */
  model: string;
  hint: string;
}

export const LOCAL_LLM_PRESETS: readonly LocalLlmPreset[] = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5-coder:7b', hint: 'ollama pull qwen2.5-coder:7b' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234', model: 'local-model', hint: 'Load a model, then start the server in LM Studio' },
  { id: 'local', label: 'Other local server', baseUrl: 'http://localhost:8000', model: 'local-model', hint: 'Any OpenAI-compatible server: vLLM, llama.cpp, LocalAI…' }
];

/** What the Provider dropdown shows: a hosted provider, or one of the local servers. */
export type ProviderChoice = LLMProvider | LocalLlmPreset['id'];

export const PROVIDER_CHOICES: ReadonlyArray<{ value: ProviderChoice; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  ...LOCAL_LLM_PRESETS.map((preset) => ({ value: preset.id, label: `${preset.label} (local)` }))
];

const portOf = (url: string): string => {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
};

/**
 * Derive the dropdown value from saved settings. Local servers are stored as the OpenAI provider
 * with a loopback base URL; the port tells Ollama (11434) and LM Studio (1234) apart.
 */
export const providerChoiceOf = (settings: Pick<ExtensionSettings, 'provider' | 'openAiBaseUrl'>): ProviderChoice => {
  if (!usesLocalLlm(settings)) return settings.provider;
  const port = portOf(settings.openAiBaseUrl ?? '');
  return LOCAL_LLM_PRESETS.find((preset) => preset.id !== 'local' && portOf(preset.baseUrl) === port)?.id ?? 'local';
};

/** Settings to save when the user picks a dropdown entry. */
export const settingsForChoice = (choice: ProviderChoice): Partial<ExtensionSettings> => {
  const preset = LOCAL_LLM_PRESETS.find((item) => item.id === choice);
  if (preset) {
    return { provider: 'openai', openAiBaseUrl: preset.baseUrl, model: preset.model };
  }
  const provider = choice as LLMProvider;
  return {
    provider,
    model: PROVIDER_MODELS[provider][0],
    // Leaving a local server for hosted OpenAI must not keep pointing at localhost.
    ...(provider === 'openai' ? { openAiBaseUrl: DEFAULT_OPENAI_BASE_URL } : {})
  };
};

export const localPresetFor = (choice: ProviderChoice): LocalLlmPreset | undefined =>
  LOCAL_LLM_PRESETS.find((preset) => preset.id === choice);

/** Placeholder bearer token — local servers ignore it, but the adapter requires a non-empty key. */
export const LOCAL_LLM_KEY = 'local';

export const usesLocalLlm = (settings: Pick<ExtensionSettings, 'provider' | 'openAiBaseUrl'>): boolean =>
  settings.provider === 'openai' && isLoopbackUrl(settings.openAiBaseUrl ?? '');

/** The key to send for a provider, or '' when it is unusable (no key and not a local server). */
export const providerKeyFor = (settings: ExtensionSettings, provider: LLMProvider): string => {
  if (provider === 'openai') {
    // Never hand a saved OpenAI key to a local process; local servers don't need one.
    return isLoopbackUrl(settings.openAiBaseUrl ?? '') ? LOCAL_LLM_KEY : settings.openAiKey ?? '';
  }
  return (provider === 'claude' ? settings.claudeKey : settings.geminiKey) ?? '';
};

/** True when the selected provider can generate (a key, or a local model server). */
export const isProviderConfigured = (settings: ExtensionSettings): boolean =>
  Boolean(settings.openAiKey || settings.claudeKey || settings.geminiKey || usesLocalLlm(settings));
