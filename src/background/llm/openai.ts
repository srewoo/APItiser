import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildPrompt, parseProviderOutput } from './promptBuilder';
import { withRetry } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';

interface OpenAiResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class OpenAiAdapter implements LLMProviderAdapter {
  readonly provider = 'openai' as const;

  async generateTests(
    batch: ApiEndpoint[],
    context: GenerateContext,
    options: ProviderOptions
  ): Promise<ProviderResult> {
    const prompt = buildPrompt(batch, context);

    const content = await withRetry(
      async () => {
        const response = await fetchWithTimeout(
          'https://api.openai.com/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.apiKey}`
            },
            body: JSON.stringify({
              model: options.model,
              temperature: 0.2,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content: 'You generate API test specifications in strict JSON.'
                },
                {
                  role: 'user',
                  content: `${prompt}\nReturn this JSON object shape only: {"tests": [...]}`
                }
              ]
            })
          },
          options.timeoutMs,
          options.signal
        );

        if (!response.ok) {
          throw new Error(`OpenAI call failed: ${response.status}`);
        }

        const json = (await response.json()) as OpenAiResponse;
        return json.choices?.[0]?.message?.content ?? '';
      },
      { signal: options.signal, retries: 3 }
    );

    const parsedObject = JSON.parse(content) as { tests?: unknown[] };
    const tests = Array.isArray(parsedObject.tests)
      ? (parsedObject.tests as ProviderResult['tests'])
      : (parseProviderOutput(content) as ProviderResult['tests']);

    return {
      tests,
      rawText: content
    };
  }
}
