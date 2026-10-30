import type { ApiEndpoint, GenerateContext, LLMProviderAdapter, ProviderOptions, ProviderResult } from '@shared/types';
import { buildProviderPrompt, buildProviderSystemPrompt, computeMaxOutputTokens, parseProviderOutput } from './promptBuilder';
import { resolveTemperature, openAiTokenField, rejectedOpenAiParam } from './modelCapabilities';
import { withRetry, HttpError } from '@background/utils/retry';
import { fetchWithTimeout } from './fetchWithTimeout';
import { DEFAULT_OPENAI_BASE_URL } from '@shared/constants';

/** Join a configured base URL with the chat-completions path, tolerating a trailing slash. */
const chatCompletionsUrl = (baseUrl: string | undefined): string => {
  const base = (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  return `${base}/v1/chat/completions`;
};

interface OpenAiResponse {
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
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
    const systemPrompt = options.systemOverride ?? buildProviderSystemPrompt(this.provider, mode);

    // Reasoning models (o-series, gpt-5 family) reject `temperature` and require
    // `max_completion_tokens`; classic models take `temperature` + `max_tokens`.
    let temperature = resolveTemperature(this.provider, options.model, options.temperature);
    let tokenField = openAiTokenField(options.model);
    let tokenFieldSwapped = false;

    const { content, usage } = await withRetry(
      async () => {
        const send = () => fetchWithTimeout(
          chatCompletionsUrl(options.baseUrl),
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

        let response = await send();
        // A model the patterns don't know may still reject temperature or the token-limit
        // field: drop/swap exactly what the API names and retry, at most once per parameter.
        while (response.status === 400) {
          const detail = await response.text();
          const rejected = rejectedOpenAiParam(detail);
          if (rejected === 'temperature' && temperature !== undefined) {
            temperature = undefined;
          } else if (rejected === 'token_field' && !tokenFieldSwapped) {
            tokenFieldSwapped = true;
            tokenField = tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
          } else {
            throw new HttpError(`OpenAI call failed: 400 ${detail.slice(0, 200)}`, 400);
          }
          response = await send();
        }

        if (!response.ok) {
          throw new HttpError(`OpenAI call failed: ${response.status}`, response.status);
        }

        const json = (await response.json()) as OpenAiResponse;
        if (json.choices?.[0]?.finish_reason === 'length') {
          console.warn('[APItiser] OpenAI response hit the output-token limit; tests may be truncated. Reduce batch size for full coverage.');
        }
        return {
          content: json.choices?.[0]?.message?.content ?? '',
          usage: {
            inputTokens: json.usage?.prompt_tokens ?? 0,
            outputTokens: json.usage?.completion_tokens ?? 0
          }
        };
      },
      { signal: options.signal, retries: 3 }
    );

    return {
      tests: options.rawOutput ? [] : (parseProviderOutput(content) as ProviderResult['tests']),
      rawText: content,
      usage
    };
  }
}
