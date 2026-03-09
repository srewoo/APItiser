import { describe, expect, it } from 'vitest';
import { buildPrompt } from '@background/llm/promptBuilder';
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
  });
});
