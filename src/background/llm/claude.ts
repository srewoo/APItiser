import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildProviderPrompt, buildProviderSystemPrompt, parseProviderOutput } from './promptBuilder';
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
    const mode = options.promptMode ?? 'generate';
    const prompt = options.promptOverride ?? buildProviderPrompt(this.provider, batch, context, {
      mode,
      currentTests: options.currentTests,
      issues: options.repairIssues
    });
    const systemPrompt = buildProviderSystemPrompt(this.provider, mode);

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
              system: systemPrompt,
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
