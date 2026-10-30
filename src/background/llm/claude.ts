import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildProviderPrompt, buildProviderSystemPrompt, computeMaxOutputTokens, parseProviderOutput } from './promptBuilder';
import { withRetry, HttpError } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';

interface ClaudeResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class ClaudeAdapter implements LLMProviderAdapter {
  readonly provider = 'claude' as const;

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
    const systemPrompt = options.systemOverride ?? buildProviderSystemPrompt(this.provider, mode);

    const { text, usage } = await withRetry(
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
              max_tokens: computeMaxOutputTokens(batch.length),
              // The system prompt is large and identical across every batch in a run, so mark
              // it cacheable — Anthropic prompt caching then bills cache-read rates on repeats.
              system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
              messages: [{ role: 'user', content: prompt }]
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
          throw new HttpError(`Claude call failed: ${response.status}`, response.status);
        }

        const json = (await response.json()) as ClaudeResponse;
        if (json.stop_reason === 'max_tokens') {
          console.warn('[APItiser] Claude response hit max_tokens; tests may be truncated. Reduce batch size for full coverage.');
        }
        const firstText = json.content.find((item) => item.type === 'text')?.text;
        const inputTokens =
          (json.usage?.input_tokens ?? 0) +
          (json.usage?.cache_read_input_tokens ?? 0) +
          (json.usage?.cache_creation_input_tokens ?? 0);
        return {
          text: firstText ?? '[]',
          usage: { inputTokens, outputTokens: json.usage?.output_tokens ?? 0 }
        };
      },
      { signal: options.signal, retries: 3 }
    );

    return {
      tests: options.rawOutput ? [] : (parseProviderOutput(text) as ProviderResult['tests']),
      rawText: text,
      usage
    };
  }
}
