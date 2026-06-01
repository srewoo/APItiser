import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildProviderPrompt, buildProviderSystemPrompt, computeMaxOutputTokens, parseProviderOutput } from './promptBuilder';
import { withRetry } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
}

export class GeminiAdapter implements LLMProviderAdapter {
  readonly provider = 'gemini' as const;

  async generateTests(
    batch: ApiEndpoint[],
    context: GenerateContext,
    options: ProviderOptions
  ): Promise<ProviderResult> {
    const mode = options.promptMode ?? 'generate';
    const prompt = options.promptOverride ?? buildProviderPrompt(this.provider, batch, context, {
      mode,
      currentTests: options.currentTests,
      issues: options.repairIssues
    });
    const systemPrompt = buildProviderSystemPrompt(this.provider, mode);

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
              systemInstruction: {
                parts: [{ text: systemPrompt }]
              },
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
                maxOutputTokens: computeMaxOutputTokens(batch.length)
              },
              contents: [
                {
                  role: 'user',
                  parts: [{ text: prompt }]
                }
              ]
            })
          },
          {
            timeoutMs: options.timeoutMs,
            hardTimeoutMs: options.hardTimeoutMs,
            heartbeatMs: options.heartbeatMs,
            onHeartbeat: options.onHeartbeat,
            parentSignal: options.signal
          }
        );

        if (!response.ok) {
          throw new Error(`Gemini call failed: ${response.status}`);
        }

        const json = (await response.json()) as GeminiResponse;
        if (json.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
          console.warn('[APItiser] Gemini response hit maxOutputTokens; tests may be truncated. Reduce batch size for full coverage.');
        }
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
