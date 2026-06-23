/**
 * Deterministic, schema-driven test synthesis.
 *
 * Negative and edge cases are the one place test generation can be exhaustive and exact
 * rather than improvised by the model: given a parsed request schema we can mechanically
 * produce "omit each required field", "wrong type per field", "violate enum", and boundary
 * cases. These supplement the LLM output (they are merged and de-duplicated by the engine),
 * guaranteeing baseline negative/edge coverage even when the model omits or weakens it.
 */
import { buildExamplePath, defaultExpectedStatus, sampleValueForField } from '@background/llm/endpointUtils';
import type { ApiEndpoint, GeneratedTestCase, SchemaField, SchemaObject, TestCategory } from '@shared/types';

interface FlatField {
  name: string;
  required: boolean;
  type: string;
  format?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

const isSchemaField = (value: SchemaObject | SchemaField): value is SchemaField => 'name' in value;

/** Flatten a body object schema's top-level properties into a typed field list. */
const flattenBodyFields = (body?: SchemaObject): FlatField[] => {
  if (!body || body.type !== 'object' || !body.properties) {
    return [];
  }
  const required = new Set(body.required ?? []);
  return Object.entries(body.properties).map(([name, value]) => {
    const constraints = value as Partial<FlatField>;
    return {
      name,
      required: isSchemaField(value) ? value.required || required.has(name) : required.has(name),
      type: value.type ?? 'string',
      format: isSchemaField(value) ? value.format : undefined,
      enum: constraints.enum,
      minimum: constraints.minimum,
      maximum: constraints.maximum,
      minLength: constraints.minLength,
      maxLength: constraints.maxLength
    };
  });
};

const validValueForField = (field: FlatField): unknown => {
  if (Array.isArray(field.enum) && field.enum.length) {
    return field.enum[0];
  }
  if (field.type === 'string' && typeof field.minLength === 'number' && field.minLength > 0) {
    return 'a'.repeat(field.minLength);
  }
  if ((field.type === 'integer' || field.type === 'number') && typeof field.minimum === 'number') {
    return field.minimum;
  }
  return sampleValueForField(field.name, field.type, field.format);
};

const buildValidBody = (fields: FlatField[]): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    body[field.name] = validValueForField(field);
  }
  return body;
};

const wrongTypeValue = (type: string): unknown => {
  switch (type) {
    case 'integer':
    case 'number':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return 'not-an-array';
    case 'object':
      return 'not-an-object';
    default:
      // For strings, a number is the canonical type violation.
      return 12345;
  }
};

const baseCase = (
  endpoint: ApiEndpoint,
  category: TestCategory,
  title: string,
  body: unknown,
  status: number,
  extra?: Partial<GeneratedTestCase['expected']>
): GeneratedTestCase => ({
  endpointId: endpoint.id,
  category,
  title,
  rationale: 'Schema-derived deterministic case',
  trustScore: 80,
  trustLabel: 'medium',
  request: {
    method: endpoint.method,
    path: buildExamplePath(endpoint),
    headers: {},
    query: {},
    body
  },
  expected: {
    status,
    contains: [],
    responseHeaders: {},
    contractChecks: [],
    bodyAssertions: [],
    pagination: false,
    idempotent: ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method),
    ...extra
  }
});

const methodTakesBody = (method: string): boolean => ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());

const MAX_PER_KIND = 3;

const synthesizeNegatives = (endpoint: ApiEndpoint, fields: FlatField[]): GeneratedTestCase[] => {
  const cases: GeneratedTestCase[] = [];
  const validBody = buildValidBody(fields);
  const label = `${endpoint.method} ${endpoint.path}`;
  const requiredFields = fields.filter((field) => field.required);

  // Omit each required field.
  for (const field of requiredFields.slice(0, MAX_PER_KIND)) {
    const body = { ...validBody };
    delete body[field.name];
    cases.push(baseCase(endpoint, 'negative', `Reject ${label} when required field "${field.name}" is missing`, body, 422));
  }

  // Wrong type for each scalar field.
  for (const field of fields.filter((f) => ['integer', 'number', 'boolean'].includes(f.type)).slice(0, MAX_PER_KIND)) {
    const body = { ...validBody, [field.name]: wrongTypeValue(field.type) };
    cases.push(baseCase(endpoint, 'negative', `Reject ${label} when "${field.name}" has the wrong type`, body, 422));
  }

  // Invalid enum value.
  for (const field of fields.filter((f) => Array.isArray(f.enum) && f.enum.length).slice(0, MAX_PER_KIND)) {
    const body = { ...validBody, [field.name]: '__not_a_valid_enum_value__' };
    cases.push(baseCase(endpoint, 'negative', `Reject ${label} when "${field.name}" is outside its allowed values`, body, 422));
  }

  // Empty body when fields are required.
  if (requiredFields.length && methodTakesBody(endpoint.method)) {
    cases.push(baseCase(endpoint, 'negative', `Reject ${label} with an empty request body`, {}, 422));
  }

  return cases;
};

const synthesizeEdges = (endpoint: ApiEndpoint, fields: FlatField[]): GeneratedTestCase[] => {
  const cases: GeneratedTestCase[] = [];
  const validBody = buildValidBody(fields);
  const label = `${endpoint.method} ${endpoint.path}`;
  const successStatus = defaultExpectedStatus(endpoint);

  // String length boundary (max).
  for (const field of fields.filter((f) => f.type === 'string' && typeof f.maxLength === 'number').slice(0, MAX_PER_KIND)) {
    const body = { ...validBody, [field.name]: 'x'.repeat(field.maxLength as number) };
    cases.push(baseCase(endpoint, 'edge', `${label} accepts "${field.name}" at its maximum length`, body, successStatus));
  }

  // Numeric boundary (max).
  for (const field of fields.filter((f) => (f.type === 'integer' || f.type === 'number') && typeof f.maximum === 'number').slice(0, MAX_PER_KIND)) {
    const body = { ...validBody, [field.name]: field.maximum };
    cases.push(baseCase(endpoint, 'edge', `${label} accepts "${field.name}" at its maximum value`, body, successStatus));
  }

  // Pagination boundaries for list endpoints.
  const paginationParam = endpoint.queryParams.find((param) => /page|limit|offset|cursor/i.test(param.name));
  if (paginationParam) {
    cases.push(
      baseCase(endpoint, 'edge', `${label} handles a minimal page size`, undefined, successStatus, {
        pagination: true,
        bodyAssertions: []
      })
    );
    cases[cases.length - 1].request.query = { [paginationParam.name]: 1 };
  }

  return cases;
};

/**
 * Produce deterministic, schema-grounded cases for the requested categories. Returns an
 * empty array when the endpoint exposes no schema to reason about.
 */
export const synthesizeDeterministicCases = (
  endpoint: ApiEndpoint,
  categories: TestCategory[]
): GeneratedTestCase[] => {
  const fields = flattenBodyFields(endpoint.body);
  const cases: GeneratedTestCase[] = [];

  if (categories.includes('negative')) {
    cases.push(...synthesizeNegatives(endpoint, fields));
  }
  if (categories.includes('edge')) {
    cases.push(...synthesizeEdges(endpoint, fields));
  }

  return cases;
};
