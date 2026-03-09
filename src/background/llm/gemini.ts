import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildPrompt, parseProviderOutput } from './promptBuilder';
import { withRetry } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export class GeminiAdapter implements LLMProviderAdapter {
  readonly provider = 'gemini' as const;

  async generateTests(
    batch: ApiEndpoint[],
    context: GenerateContext,
    options: ProviderOptions
  ): Promise<ProviderResult> {
    const prompt = buildPrompt(batch, context);

    const text = await withRetry(
      async () => {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`;

        const response = await fetchWithTimeout(
          endpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json'
              },
              contents: [
                {
                  role: 'user',
                  parts: [{ text: prompt }]
                }
              ]
            })
          },
          options.timeoutMs,
          options.signal
        );

        if (!response.ok) {
          throw new Error(`Gemini call failed: ${response.status}`);
        }

        const json = (await response.json()) as GeminiResponse;
        const output = json.candidates?.[0]?.content?.parts?.[0]?.text;
        return output ?? '[]';
      },
      { signal: options.signal, retries: 3 }
    );

    return {
      tests: parseProviderOutput(text) as ProviderResult['tests'],
      rawText: text
    };
  }
}
