import { describe, expect, it } from 'vitest';
import { isPlausibleRawTest, parseGeneratedTestCase } from '@shared/schemas';
import { makeGeneratedTestCase } from '@shared/testing/factories';

describe('rawGeneratedTestSchema / isPlausibleRawTest', () => {
  it('should accept a minimal raw item with just endpointId and category', () => {
    expect(isPlausibleRawTest({ endpointId: 'GET::/x', category: 'positive' })).toBe(true);
  });

  it('should accept a numeric endpointId (coercible)', () => {
    expect(isPlausibleRawTest({ endpointId: 42 })).toBe(true);
  });

  it('should reject non-objects', () => {
    expect(isPlausibleRawTest(null)).toBe(false);
    expect(isPlausibleRawTest('a string')).toBe(false);
    expect(isPlausibleRawTest(7)).toBe(false);
  });

  it('should reject items whose request is not an object', () => {
    expect(isPlausibleRawTest({ endpointId: 'x', request: 'GET /x' })).toBe(false);
  });

  it('should reject items whose expected is an array instead of an object', () => {
    expect(isPlausibleRawTest({ endpointId: 'x', expected: [200] })).toBe(false);
  });
});

describe('generatedTestCaseSchema / parseGeneratedTestCase', () => {
  it('should validate a well-formed normalized test case', () => {
    const test = makeGeneratedTestCase();
    expect(parseGeneratedTestCase(test)).not.toBeNull();
  });

  it('should reject a test with an out-of-range status', () => {
    const test = { ...makeGeneratedTestCase(), expected: { status: 9000 } };
    expect(parseGeneratedTestCase(test)).toBeNull();
  });

  it('should reject a test missing the request block', () => {
    const test = makeGeneratedTestCase();
    const broken = { ...test, request: undefined };
    expect(parseGeneratedTestCase(broken)).toBeNull();
  });

  it('should reject an unknown category', () => {
    const test = { ...makeGeneratedTestCase(), category: 'chaos' };
    expect(parseGeneratedTestCase(test)).toBeNull();
  });

  it('should preserve a valid jsonSchema on the expected block', () => {
    const base = makeGeneratedTestCase();
    const withSchema = {
      ...base,
      expected: { ...base.expected, status: 200, jsonSchema: { type: 'object', properties: {} } }
    };
    const parsed = parseGeneratedTestCase(withSchema);
    expect(parsed?.expected.jsonSchema).toEqual({ type: 'object', properties: {} });
  });
});
