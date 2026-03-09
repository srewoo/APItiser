import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildPrompt, parseProviderOutput } from './promptBuilder';
import { withRetry } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';

interface ClaudeResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
}

export class ClaudeAdapter implements LLMProviderAdapter {
  readonly provider = 'claude' as const;

  async generateTests(
    batch: ApiEndpoint[],
    context: GenerateContext,
    options: ProviderOptions
  ): Promise<ProviderResult> {
    const prompt = buildPrompt(batch, context);

    const text = await withRetry(
      async () => {
        const response = await fetchWithTimeout(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': options.apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: options.model,
              max_tokens: 6000,
              messages: [{ role: 'user', content: `${prompt}\nReturn strict JSON array.` }]
            })
          },
          options.timeoutMs,
          options.signal
        );

        if (!response.ok) {
          throw new Error(`Claude call failed: ${response.status}`);
        }

        const json = (await response.json()) as ClaudeResponse;
        const firstText = json.content.find((item) => item.type === 'text')?.text;
        return firstText ?? '[]';
      },
      { signal: options.signal, retries: 3 }
    );

    return {
      tests: parseProviderOutput(text) as ProviderResult['tests'],
      rawText: text
    };
  }
}
