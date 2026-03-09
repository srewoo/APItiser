import type { ApiEndpoint, GenerateContext, TestCategory } from '@shared/types';

const METHOD_DEFAULTS: Record<string, number> = {
  GET: 200,
  POST: 201,
  PUT: 200,
  PATCH: 200,
  DELETE: 204,
  OPTIONS: 200,
  HEAD: 200
};

const categoriesAsSentence = (categories: TestCategory[]): string =>
  categories
    .map((item) => {
      if (item === 'positive') {
        return 'positive cases';
      }
      if (item === 'negative') {
        return 'negative cases';
      }
      return 'edge cases';
    })
    .join(', ');

export const buildPrompt = (batch: ApiEndpoint[], context: GenerateContext): string => {
  const constraints = {
    framework: context.framework,
    categories: context.includeCategories,
    mustReturn: 'json-array',
    jsonSchema: {
      endpointId: 'string',
      category: 'positive|negative|edge',
      title: 'string',
      request: {
        method: 'string',
        path: 'string',
        headers: 'record<string,string>',
        query: 'record<string,unknown>',
        body: 'unknown'
      },
      expected: {
        status: 'number',
        contains: 'string[]'
      }
    }
  };

  const endpointInput = batch.map((endpoint) => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    pathParams: endpoint.pathParams,
    queryParams: endpoint.queryParams,
    body: endpoint.body,
    responses: endpoint.responses,
    defaultExpectedStatus: METHOD_DEFAULTS[endpoint.method] ?? 200
  }));

  return [
    'You are APItiser test-generation engine.',
    `Generate ${categoriesAsSentence(context.includeCategories)} for each API endpoint.`,
    'Return strict JSON only, no markdown and no explanations.',
    'Each endpoint should receive at least 3 tests distributed across selected categories where possible.',
    'Do not invent endpoints. Use endpoint id exactly as provided.',
    `Constraints: ${JSON.stringify(constraints)}`,
    `Endpoints: ${JSON.stringify(endpointInput)}`
  ].join('\n');
};

const jsonBlockRegex = /```json\s*([\s\S]*?)```/i;

export const parseProviderOutput = (value: string) => {
  const fenced = value.match(jsonBlockRegex);
  const raw = fenced ? fenced[1].trim() : value.trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Provider output was not an array');
  }
  return parsed;
};
