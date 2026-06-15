import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildProviderPrompt, buildProviderSystemPrompt, computeMaxOutputTokens, parseProviderOutput } from './promptBuilder';
import { resolveTemperature, openAiTokenField } from './modelCapabilities';
import { withRetry } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';

interface OpenAiResponse {
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason?: string;
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

    // Reasoning models (o-series, gpt-5 family) reject `temperature` and require
    // `max_completion_tokens`; classic models take `temperature` + `max_tokens`.
    const temperature = resolveTemperature(this.provider, options.model, options.temperature);
    const tokenField = openAiTokenField(options.model);

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
              ...(temperature !== undefined ? { temperature } : {}),
              [tokenField]: computeMaxOutputTokens(batch.length),
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
        if (json.choices?.[0]?.finish_reason === 'length') {
          console.warn('[APItiser] OpenAI response hit the output-token limit; tests may be truncated. Reduce batch size for full coverage.');
        }
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
