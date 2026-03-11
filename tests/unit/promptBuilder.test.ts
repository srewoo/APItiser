import { describe, expect, it } from 'vitest';
import { buildPrompt, buildProviderPrompt, buildProviderSystemPrompt, buildRepairPrompt, parseProviderOutput } from '@background/llm/promptBuilder';
import type { ApiEndpoint, GenerateContext } from '@shared/types';

describe('buildPrompt', () => {
  it('includes security category in constraints when selected', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'express',
        pathParams: [{ name: 'id', required: true, type: 'string' }],
        queryParams: [],
        responses: [{ status: '200' }],
        auth: 'none'
      }
    ];

    const context: GenerateContext = {
      repo: { platform: 'github', owner: 'acme', repo: 'sample' },
      framework: 'jest',
      includeCategories: ['positive', 'security'],
      timeoutMs: 120000
    };

    const prompt = buildPrompt(endpoints, context);
    expect(prompt).toContain('security cases');
    expect(prompt).toContain('positive|negative|edge|security');
    expect(prompt).toContain('{"tests":[...]}');
  });

  it('builds a repair prompt with issues and current tests', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'GET::/users/:id',
        method: 'GET',
        path: '/users/:id',
        source: 'express',
        pathParams: [{ name: 'id', required: true, type: 'string' }],
        queryParams: [],
        responses: [{ status: '200' }],
        auth: 'none'
      }
    ];

    const context: GenerateContext = {
      repo: { platform: 'github', owner: 'acme', repo: 'sample' },
      framework: 'jest',
      includeCategories: ['positive', 'negative'],
      timeoutMs: 120000
    };

    const prompt = buildRepairPrompt(
      endpoints,
      context,
      [{ endpointId: 'GET::/users/:id', category: 'positive', title: 'gets user' }],
      [{ code: 'missing-category', severity: 'error', message: 'Missing negative test for GET /users/:id', endpointId: 'GET::/users/:id', category: 'negative' }]
    );

    expect(prompt).toContain('test-repair engine');
    expect(prompt).toContain('Missing negative test for GET /users/:id');
    expect(prompt).toContain('Current tests:');
  });

  it('wraps prompts with provider-specific guardrails', () => {
    const endpoints: ApiEndpoint[] = [
      {
        id: 'POST::/users',
        method: 'POST',
        path: '/users',
        source: 'openapi',
        pathParams: [],
        queryParams: [{ name: 'expand', required: false, type: 'string' }],
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { name: 'email', required: true, type: 'string', format: 'email' }
          }
        },
        responses: [{ status: '201' }],
        auth: 'bearer'
      }
    ];

    const context: GenerateContext = {
      repo: { platform: 'github', owner: 'acme', repo: 'sample' },
      framework: 'jest',
      includeCategories: ['positive', 'negative', 'security'],
      timeoutMs: 120000
    };

    const claudePrompt = buildProviderPrompt('claude', endpoints, context, { mode: 'repair', currentTests: [], issues: [] });
    expect(claudePrompt).toContain('Claude repair mode');
    expect(claudePrompt).toContain('concretePath');
    expect(claudePrompt).toContain('requiredFields');

    const openAiSystem = buildProviderSystemPrompt('openai', 'generate');
    expect(openAiSystem).toContain('OpenAI generation mode');
  });

  it('parses provider output from object or array shapes', () => {
    expect(parseProviderOutput('{"tests":[{"endpointId":"x"}]}')).toEqual([{ endpointId: 'x' }]);
    expect(parseProviderOutput('[{"endpointId":"x"}]')).toEqual([{ endpointId: 'x' }]);
  });
});
