import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildProviderPrompt, buildProviderSystemPrompt, parseProviderOutput } from './promptBuilder';
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
    const mode = options.promptMode ?? 'generate';
    const prompt = options.promptOverride ?? buildProviderPrompt(this.provider, batch, context, {
      mode,
      currentTests: options.currentTests,
      issues: options.repairIssues
    });
    const systemPrompt = buildProviderSystemPrompt(this.provider, mode);

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
                  content: systemPrompt
                },
                {
                  role: 'user',
                  content: prompt
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
          throw new Error(`OpenAI call failed: ${response.status}`);
        }

        const json = (await response.json()) as OpenAiResponse;
        return json.choices?.[0]?.message?.content ?? '';
      },
      { signal: options.signal, retries: 3 }
    );

    return {
      tests: parseProviderOutput(content) as ProviderResult['tests'],
      rawText: content
    };
  }
}
