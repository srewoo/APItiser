import type {
  ApiEndpoint,
  GenerateContext,
  GeneratedTestCase,
  LLMProvider,
  QualityIssue,
  TestCategory
} from '@shared/types';
import { buildExamplePath, defaultExpectedStatus, sampleValueForField } from './endpointUtils';

// METHOD_DEFAULTS, sampleValueForField, buildExamplePath, defaultExpectedStatus
// are imported from './endpointUtils' above.

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

// Local alias for backward compat within this file
const defaultExpectedStatusForEndpoint = defaultExpectedStatus;

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

// buildExamplePath is imported from './endpointUtils'

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
    authHints: endpoint.authHints,
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    description: endpoint.description,
    confidence: endpoint.confidence,
    trustScore: endpoint.trustScore,
    trustLabel: endpoint.trustLabel,
    sourceMetadata: endpoint.sourceMetadata,
    observedExamples: endpoint.examples,
    tags: endpoint.tags,
    pathParams: endpoint.pathParams,
    queryParams: endpoint.queryParams,
    body: summarizeBody(endpoint.body),
    responses: endpoint.responses.map((response) => ({
      status: response.status,
      description: response.description,
      contentType: response.contentType,
      schema: summarizeBody(response.schema)
    })),
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
      hasSecurityCases: endpoint.auth !== 'none' || endpoint.method !== 'GET',
      hasContractSchema: endpoint.responses.some((response) => Boolean(response.schema)),
      likelyPaginated: /page|limit|offset|cursor/i.test(endpoint.path) || endpoint.queryParams.some((field) => /page|limit|offset|cursor/i.test(field.name)),
      likelyIdempotent: ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method)
    },
    examples: {
      concretePath: buildExamplePath(endpoint),
      query: buildExampleObject(endpoint.queryParams),
      body: buildExampleBody(endpoint.body),
      authHeaders: Object.fromEntries(
        (endpoint.authHints ?? [])
          .filter((hint) => hint.headerName)
          .map((hint) => [
            hint.headerName!,
            hint.type === 'apiKey' ? '{{API_KEY}}' : hint.type === 'csrf' ? '{{CSRF_TOKEN}}' : 'Bearer {{API_TOKEN}}'
          ])
      )
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
          contains: 'string[]',
          contentType: 'string',
          responseHeaders: 'record<string,string>',
          jsonSchema: 'schema-object',
          contractChecks: 'string[]',
          pagination: 'boolean',
          idempotent: 'boolean'
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
    'For request.path, produce a concrete callable path. Never leave :id or {id} route placeholders.',
    'When a path or body value is the id of ANOTHER resource that cannot be known ahead of time (a foreign key, a parent resource id), do NOT fabricate a number — use a {{UPPER_SNAKE_CASE}} placeholder such as {{USER_ID}} or {{ORDER_ID}}. These are resolved from environment variables and the validation setup flow at run time, which keeps the test from 404ing on an invented id. Use the path-param name to derive the placeholder (e.g. orderId -> {{ORDER_ID}}).',
    'Ground request bodies, query values, concrete path values, and expected.contains assertions in observedExamples whenever they are present; only synthesize values when no example exists.',
    'Only put a string in expected.contains if you can ground it in observedExamples or a documented response schema field. Do not invent response text — an ungrounded contains assertion produces false failures.',
    'Prefer documented success codes from endpoint responses when available.',
    'Honor authHints exactly when present. Use Authorization, API key, cookie, or CSRF placeholders only when the endpoint metadata supports them.',
    'Negative tests should use realistic invalid inputs or missing required fields.',
    'Edge tests should stress boundaries, optional inputs, empty states, pagination limits, or uncommon but valid combinations.',
    'Security tests should focus on auth absence, auth misuse, IDOR-style access, privilege boundaries, over-posting, and input abuse that is relevant to the endpoint.',
    'For positive tests, add jsonSchema when a response schema is available and include contentType when known.',
    'Mark pagination=true when validating list endpoints with page/limit/cursor semantics.',
    'Mark idempotent=true for GET/PUT/DELETE/HEAD/OPTIONS tests that should be safely repeatable.',
    'Add contractChecks that describe key response invariants such as required fields, array/object shape, or auth boundary expectations.',
    'Do not output duplicate tests.',
    'Make titles specific and endpoint-aware.',
    ...(context.customPromptInstructions ? [`Custom Instructions: ${context.customPromptInstructions}`] : []),
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
    'Fix unresolved :id or {id} route placeholders, invalid statuses, generic titles, and missing category coverage. Keep any {{UPPER_SNAKE_CASE}} runtime placeholders (e.g. {{USER_ID}}) intact — they are resolved at run time and must not be replaced with fabricated values.',
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

/**
 * Output-token budget for a batch. Scales with batch size but is floored high enough
 * that a single batch's worth of test JSON is unlikely to be truncated, and ceilinged
 * to a value all three providers support (OpenAI gpt-4o caps completions at 16384).
 */
export const computeMaxOutputTokens = (batchLength: number): number =>
  Math.min(Math.max(batchLength * 1200, 8000), 16000);

const fencedJsonRegex = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;

/**
 * Salvage complete objects from a (possibly truncated) JSON array. When a provider's
 * response is cut off by the output-token limit, the trailing brace/bracket never
 * closes, so strict parsing fails. This walks the first array it finds and collects
 * every fully-formed `{...}` element, discarding only the incomplete trailing one —
 * so a truncated batch still yields most of its tests instead of being lost entirely.
 */
const salvageArrayObjects = (value: string): unknown[] | null => {
  const arrayStart = value.indexOf('[');
  if (arrayStart === -1) {
    return null;
  }

  const objects: unknown[] = [];
  let i = arrayStart + 1;

  while (i < value.length) {
    const ch = value[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === ']') {
      break;
    }
    if (ch !== '{') {
      break;
    }

    // Find the matching close brace for the object starting at i (string-aware).
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = i; j < value.length; j += 1) {
      const c = value[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end === -1) {
      // Truncated mid-object — stop; everything collected so far is still valid.
      break;
    }

    const objectText = value.slice(i, end + 1);
    try {
      objects.push(JSON.parse(stripTrailingCommas(objectText)));
    } catch {
      // Skip an unparseable object but keep going.
    }
    i = end + 1;
  }

  return objects.length ? objects : null;
};

const interpretParsed = (parsed: unknown): unknown[] | null => {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    const container = parsed as Record<string, unknown>;
    if (Array.isArray(container.tests)) {
      return container.tests;
    }
    if (Array.isArray(container.testCases)) {
      return container.testCases;
    }
    if (Array.isArray(container.results)) {
      return container.results;
    }
    if (Array.isArray(container.data)) {
      return container.data;
    }
  }
  return null;
};

const stripTrailingCommas = (raw: string): string => raw.replace(/,\s*([}\]])/g, '$1');

const tryParse = (raw: string): unknown[] | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const attempts = [trimmed, stripTrailingCommas(trimmed)];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      const result = interpretParsed(parsed);
      if (result) {
        return result;
      }
    } catch {
      // fall through to next strategy
    }
  }
  return null;
};

const extractBalancedBlock = (value: string, open: '{' | '['): string | null => {
  const close = open === '{' ? '}' : ']';
  const start = value.indexOf(open);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }
  return null;
};

export const parseProviderOutput = (value: string): unknown[] => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Provider output was empty');
  }

  // 1. Direct parse of the whole payload.
  const direct = tryParse(value);
  if (direct) {
    return direct;
  }

  // 2. Any fenced block (```json, ```javascript, or just ```), try each in order.
  const fencedMatches = [...value.matchAll(fencedJsonRegex)];
  for (const match of fencedMatches) {
    const block = tryParse(match[1]);
    if (block) {
      return block;
    }
  }

  // 3. Fall back to the first balanced { ... } or [ ... ] substring. This handles
  //    providers that wrap JSON in prose, prepend commentary, or add trailing notes.
  for (const opener of ['{', '['] as const) {
    let remaining = value;
    let safetyCounter = 0;
    while (remaining && safetyCounter < 10) {
      safetyCounter += 1;
      const block = extractBalancedBlock(remaining, opener);
      if (!block) {
        break;
      }
      const parsed = tryParse(block);
      if (parsed) {
        return parsed;
      }
      remaining = remaining.slice(remaining.indexOf(block) + block.length);
    }
  }

  // 4. Last resort: salvage complete objects from a truncated array. Recovers most
  //    tests when the response was cut off by the provider's output-token limit.
  const salvaged = salvageArrayObjects(value);
  if (salvaged) {
    return salvaged;
  }

  throw new Error(
    'Provider output was not a tests array or object (response may have been truncated — try reducing batch size in Settings)'
  );
};
