import type {
  ApiEndpoint,
  GenerateContext,
  GeneratedTestCase,
  LLMProvider,
  QualityIssue,
  TestCategory
} from '@shared/types';

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
      if (item === 'security') {
        return 'security cases';
      }
      return 'edge cases';
    })
    .join(', ');

const defaultExpectedStatusForEndpoint = (endpoint: ApiEndpoint): number => {
  const documented2xx = endpoint.responses
    .map((response) => Number(response.status))
    .find((status) => Number.isFinite(status) && status >= 200 && status < 300);

  return documented2xx ?? METHOD_DEFAULTS[endpoint.method] ?? 200;
};

const sampleValueForField = (name: string, type?: string, format?: string): string | number | boolean => {
  const normalizedName = name.toLowerCase();
  const normalizedType = (type ?? '').toLowerCase();
  const normalizedFormat = (format ?? '').toLowerCase();

  if (normalizedFormat === 'uuid' || normalizedName.includes('uuid')) {
    return '00000000-0000-4000-8000-000000000000';
  }
  if (normalizedFormat === 'email' || normalizedName.includes('email')) {
    return 'user@example.com';
  }
  if (normalizedType === 'integer' || normalizedType === 'number' || normalizedName === 'id' || normalizedName.endsWith('id')) {
    return 1;
  }
  if (normalizedType === 'boolean') {
    return true;
  }

  return `${normalizedName || 'sample'}-value`;
};

const summarizeBody = (body: ApiEndpoint['body']): Record<string, unknown> | undefined => {
  if (!body) {
    return undefined;
  }

  const properties = Object.entries(body.properties ?? {}).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if ('name' in value) {
      acc[key] = {
        type: value.type,
        required: value.required,
        format: value.format,
        description: value.description
      };
      return acc;
    }

    acc[key] = {
      type: value.type,
      description: value.description,
      requiredChildren: value.required ?? []
    };
    return acc;
  }, {});

  return {
    type: body.type,
    required: body.required ?? [],
    properties,
    itemsType: body.items?.type,
    description: body.description
  };
};

const buildExamplePath = (endpoint: ApiEndpoint): string => {
  const params = new Map(endpoint.pathParams.map((param) => [param.name, param]));
  return endpoint.path
    .replace(/:([A-Za-z0-9_]+)\*/g, (_match, name: string) => String(sampleValueForField(name, params.get(name)?.type, params.get(name)?.format)))
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => String(sampleValueForField(name, params.get(name)?.type, params.get(name)?.format)))
    .replace(/\{([^}]+)\}/g, (_match, name: string) => String(sampleValueForField(name, params.get(name)?.type, params.get(name)?.format)));
};

const buildExampleObject = (fields: ApiEndpoint['queryParams']): Record<string, unknown> =>
  fields.reduce<Record<string, unknown>>((acc, field) => {
    acc[field.name] = sampleValueForField(field.name, field.type, field.format);
    return acc;
  }, {});

const buildExampleBody = (body: ApiEndpoint['body']): unknown => {
  if (!body) {
    return undefined;
  }

  if (body.type === 'array') {
    return body.items ? [buildExampleBody(body.items)] : [];
  }

  if (body.type !== 'object') {
    return sampleValueForField('value', body.type);
  }

  const required = new Set(body.required ?? []);
  return Object.entries(body.properties ?? {}).reduce<Record<string, unknown>>((acc, [key, value]) => {
    const include = required.size === 0 || required.has(key);
    if (!include) {
      return acc;
    }

    if ('name' in value) {
      acc[key] = sampleValueForField(value.name, value.type, value.format);
      return acc;
    }

    acc[key] = buildExampleBody(value);
    return acc;
  }, {});
};

const buildEndpointInput = (endpoint: ApiEndpoint) => {
  const requiredFields = endpoint.body?.required ?? [];
  const optionalFields = Object.keys(endpoint.body?.properties ?? {}).filter((name) => !requiredFields.includes(name));
  const likelyIdFields = [
    ...endpoint.pathParams.filter((param) => param.name.toLowerCase().includes('id')).map((param) => param.name),
    ...endpoint.queryParams.filter((param) => param.name.toLowerCase().includes('id')).map((param) => param.name)
  ];

  return {
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    source: endpoint.source,
    auth: endpoint.auth,
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    description: endpoint.description,
    confidence: endpoint.confidence,
    pathParams: endpoint.pathParams,
    queryParams: endpoint.queryParams,
    body: summarizeBody(endpoint.body),
    responses: endpoint.responses,
    evidence: (endpoint.evidence ?? []).slice(0, 3).map((item) => ({
      filePath: item.filePath,
      line: item.line,
      reason: item.reason,
      snippet: item.snippet?.slice(0, 180)
    })),
    invariants: {
      defaultExpectedStatus: defaultExpectedStatusForEndpoint(endpoint),
      requiredFields,
      optionalFields,
      likelyIdFields,
      hasSecurityCases: endpoint.auth !== 'none' || endpoint.method !== 'GET'
    },
    examples: {
      concretePath: buildExamplePath(endpoint),
      query: buildExampleObject(endpoint.queryParams),
      body: buildExampleBody(endpoint.body)
    }
  };
};

const responseShapeInstructions = [
  'Return strict JSON only.',
  'Do not include markdown fences, prose, comments, trailing commas, or explanations.',
  'Return exactly one JSON object with this shape: {"tests":[...]}'
].join(' ');

const baseConstraints = (context: GenerateContext) => ({
  framework: context.framework,
  categories: context.includeCategories,
  mustReturn: 'json-object',
  jsonSchema: {
    tests: [
      {
        endpointId: 'string',
        category: 'positive|negative|edge|security',
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
    ]
  }
});

const providerInstruction = (provider: LLMProvider, mode: 'generate' | 'repair'): string => {
  if (provider === 'openai') {
    return mode === 'repair'
      ? 'OpenAI repair mode: return a full replacement test set in strict JSON object form. Fix every listed quality issue before returning.'
      : 'OpenAI generation mode: return only a strict JSON object response and keep each test tightly grounded in the provided endpoint evidence.';
  }
  if (provider === 'claude') {
    return mode === 'repair'
      ? 'Claude repair mode: do not add narrative. Replace weak or invalid tests and return the complete corrected batch as strict JSON only.'
      : 'Claude generation mode: be concise, avoid prose, and emit endpoint-specific tests with concrete request values in strict JSON only.';
  }
  return mode === 'repair'
    ? 'Gemini repair mode: output exactly one JSON object, no markdown, no extra text, and ensure all placeholder paths are resolved.'
    : 'Gemini generation mode: output exactly one JSON object, no markdown, and prefer concrete sample values over placeholders or abstract examples.';
};

export const buildProviderSystemPrompt = (provider: LLMProvider, mode: 'generate' | 'repair'): string => [
  'You generate API test specifications for APItiser.',
  providerInstruction(provider, mode),
  responseShapeInstructions
].join(' ');

export const buildPrompt = (batch: ApiEndpoint[], context: GenerateContext): string => {
  const endpointInput = batch.map(buildEndpointInput);

  return [
    'You are APItiser test-generation engine.',
    `Generate ${categoriesAsSentence(context.includeCategories)} for each API endpoint.`,
    responseShapeInstructions,
    'Each endpoint should receive one test for every selected category whenever the category is applicable.',
    'Prefer 4-8 high-signal tests total per endpoint instead of many weak variants.',
    'Do not invent endpoints. Use endpoint id exactly as provided.',
    'Use the exact HTTP method for each endpoint.',
    'For request.path, produce a concrete callable path with realistic sample values for path params. Do not leave :id or {id} placeholders.',
    'Prefer documented success codes from endpoint responses when available.',
    'If auth is bearer, include an Authorization header placeholder.',
    'Negative tests should use realistic invalid inputs or missing required fields.',
    'Edge tests should stress boundaries, optional inputs, empty states, pagination limits, or uncommon but valid combinations.',
    'Security tests should focus on auth absence, auth misuse, IDOR-style access, privilege boundaries, over-posting, and input abuse that is relevant to the endpoint.',
    'Do not output duplicate tests.',
    'Make titles specific and endpoint-aware.',
    `Constraints: ${JSON.stringify(baseConstraints(context))}`,
    `Endpoints: ${JSON.stringify(endpointInput)}`
  ].join('\n');
};

export const buildRepairPrompt = (
  batch: ApiEndpoint[],
  context: GenerateContext,
  currentTests: unknown,
  issues: Array<string | QualityIssue>
): string => {
  return [
    'You are APItiser test-repair engine.',
    responseShapeInstructions,
    'You are given the original endpoints, the current generated tests, and the quality issues found.',
    'Fix the issues and return a complete replacement test set for this batch.',
    'Preserve good tests when possible, but remove invalid or duplicate tests.',
    'Every returned test must map to one of the provided endpoint ids.',
    'Fix placeholder request paths, invalid statuses, generic titles, and missing category coverage.',
    `Selected categories: ${categoriesAsSentence(context.includeCategories)}`,
    `Issues: ${JSON.stringify(issues)}`,
    `Endpoints: ${JSON.stringify(batch.map(buildEndpointInput))}`,
    `Current tests: ${JSON.stringify(currentTests)}`
  ].join('\n');
};

export const buildProviderPrompt = (
  provider: LLMProvider,
  batch: ApiEndpoint[],
  context: GenerateContext,
  options?: {
    mode?: 'generate' | 'repair';
    currentTests?: GeneratedTestCase[];
    issues?: QualityIssue[];
  }
): string => {
  const mode = options?.mode ?? 'generate';
  const providerLead = providerInstruction(provider, mode);
  const basePrompt = mode === 'repair'
    ? buildRepairPrompt(batch, context, options?.currentTests ?? [], options?.issues ?? [])
    : buildPrompt(batch, context);

  return [providerLead, basePrompt].join('\n');
};

const jsonBlockRegex = /```json\s*([\s\S]*?)```/i;

export const parseProviderOutput = (value: string) => {
  const fenced = value.match(jsonBlockRegex);
  const raw = fenced ? fenced[1].trim() : value.trim();
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tests?: unknown[] }).tests)) {
    return (parsed as { tests: unknown[] }).tests;
  }
  throw new Error('Provider output was not a tests array or object');
};
