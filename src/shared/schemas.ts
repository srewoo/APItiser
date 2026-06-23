import { z } from 'zod';
import type { GeneratedTestCase } from './types';

/**
 * Runtime schemas for untrusted boundaries. These mirror the TypeScript shapes in
 * types.ts but are enforced at runtime so malformed data (most importantly LLM output)
 * is rejected and degraded gracefully rather than coerced and trusted structurally.
 */

const testCategorySchema = z.enum(['positive', 'negative', 'edge', 'security']);
const trustLabelSchema = z.enum(['high', 'medium', 'heuristic']);

// SchemaObject is recursive; z.lazy keeps the definition self-referential.
const schemaObjectSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      required: z.array(z.string()).optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
      items: z.unknown().optional(),
      description: z.string().optional(),
      example: z.unknown().optional(),
      enum: z.array(z.unknown()).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
      pattern: z.string().optional()
    })
    .passthrough()
);

const bodyAssertionSchema = z.object({
  path: z.string(),
  op: z.enum(['equals', 'contains', 'exists', 'absent', 'type', 'matches', 'gt', 'lt', 'gte', 'lte', 'in', 'length']),
  value: z.unknown().optional(),
  description: z.string().optional()
});

const generatedRequestSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  identity: z.enum(['primary', 'secondary', 'none']).optional()
});

const generatedExpectedSchema = z.object({
  status: z.number().int().min(100).max(599),
  contains: z.array(z.string()).optional(),
  contentType: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  jsonSchema: schemaObjectSchema.optional(),
  contractChecks: z.array(z.string()).optional(),
  bodyAssertions: z.array(bodyAssertionSchema).optional(),
  pagination: z.boolean().optional(),
  idempotent: z.boolean().optional()
});

/**
 * Strict schema for a fully-normalized GeneratedTestCase. Used as the final guard in
 * normalizeGeneratedTests so every emitted test is guaranteed to conform structurally.
 */
export const generatedTestCaseSchema = z.object({
  endpointId: z.string().min(1),
  category: testCategorySchema,
  title: z.string().min(1),
  rationale: z.string().optional(),
  trustScore: z.number().optional(),
  trustLabel: trustLabelSchema.optional(),
  order: z.number().optional(),
  isSetup: z.boolean().optional(),
  isTeardown: z.boolean().optional(),
  request: generatedRequestSchema,
  expected: generatedExpectedSchema
});

/**
 * Permissive schema for a RAW LLM test item, before normalization fills defaults.
 * Rejects only structurally-wrong items (non-object request/expected, etc.) so obvious
 * garbage is dropped early while still allowing minimal `{ endpointId, category }` items.
 */
export const rawGeneratedTestSchema = z
  .object({
    endpointId: z.union([z.string(), z.number()]).optional(),
    category: z.string().optional(),
    title: z.string().optional(),
    rationale: z.string().optional(),
    request: z.record(z.string(), z.unknown()).optional(),
    expected: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

export type GeneratedTestCaseInput = z.infer<typeof generatedTestCaseSchema>;

/** Validate a normalized test, returning it typed or null if it does not conform. */
export const parseGeneratedTestCase = (value: unknown): GeneratedTestCase | null => {
  const result = generatedTestCaseSchema.safeParse(value);
  return result.success ? (result.data as GeneratedTestCase) : null;
};

/** True when a raw LLM item is structurally plausible enough to attempt normalization. */
export const isPlausibleRawTest = (value: unknown): boolean => rawGeneratedTestSchema.safeParse(value).success;
