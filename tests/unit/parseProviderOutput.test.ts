import { describe, expect, it } from 'vitest';
import { computeMaxOutputTokens, parseProviderOutput } from '@background/llm/promptBuilder';

describe('parseProviderOutput — format drift resilience', () => {
  const exampleTest = { endpointId: 'GET::/users', category: 'positive', title: 'lists users' };

  it('parses a direct JSON array', () => {
    const out = parseProviderOutput(JSON.stringify([exampleTest]));
    expect(out).toEqual([exampleTest]);
  });

  it('parses a direct {tests: [...]} object', () => {
    const out = parseProviderOutput(JSON.stringify({ tests: [exampleTest] }));
    expect(out).toEqual([exampleTest]);
  });

  it('accepts common alternate container keys (testCases, results, data)', () => {
    expect(parseProviderOutput(JSON.stringify({ testCases: [exampleTest] }))).toEqual([exampleTest]);
    expect(parseProviderOutput(JSON.stringify({ results: [exampleTest] }))).toEqual([exampleTest]);
    expect(parseProviderOutput(JSON.stringify({ data: [exampleTest] }))).toEqual([exampleTest]);
  });

  it('parses ```json fenced blocks', () => {
    const value = '```json\n' + JSON.stringify({ tests: [exampleTest] }) + '\n```';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });

  it('parses plain ``` fenced blocks without language marker', () => {
    const value = '```\n' + JSON.stringify({ tests: [exampleTest] }) + '\n```';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });

  it('parses ```javascript fenced blocks', () => {
    const value = '```javascript\n' + JSON.stringify({ tests: [exampleTest] }) + '\n```';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });

  it('extracts JSON when wrapped in prose (leading and trailing commentary)', () => {
    const value = 'Sure, here are the tests you requested:\n'
      + JSON.stringify({ tests: [exampleTest] })
      + '\n\nLet me know if you need more!';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });

  it('tolerates trailing commas', () => {
    const value = '{"tests":[' + JSON.stringify(exampleTest) + ',]}';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });

  it('handles multiple fenced blocks and picks the first valid one', () => {
    const value = '```json\nnot-json\n```\n\n```json\n'
      + JSON.stringify({ tests: [exampleTest] })
      + '\n```';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });

  it('handles braces inside string values correctly (balanced extraction)', () => {
    const testWithBraces = { ...exampleTest, rationale: 'uses {placeholder} values' };
    const value = 'prefix ' + JSON.stringify({ tests: [testWithBraces] }) + ' suffix';
    expect(parseProviderOutput(value)).toEqual([testWithBraces]);
  });

  it('throws a clear error for empty input', () => {
    expect(() => parseProviderOutput('')).toThrow(/empty/i);
    expect(() => parseProviderOutput('   ')).toThrow(/empty/i);
  });

  it('throws when no parseable JSON can be found', () => {
    expect(() => parseProviderOutput('this is just prose with no json anywhere')).toThrow(/not a tests array or object/);
  });

  it('throws when parsed shape is neither array nor tests-container', () => {
    expect(() => parseProviderOutput(JSON.stringify({ foo: 'bar' }))).toThrow();
  });

  it('strips markdown fences with extra whitespace and newlines', () => {
    const value = '\n\n```json\n\n\n' + JSON.stringify([exampleTest]) + '\n\n\n```\n\n';
    expect(parseProviderOutput(value)).toEqual([exampleTest]);
  });
});

describe('parseProviderOutput — truncated response salvage', () => {
  const t1 = { endpointId: 'POST::/a', category: 'positive', title: 'creates a', request: { method: 'POST', path: '/a' }, expected: { status: 201 } };
  const t2 = { endpointId: 'POST::/b', category: 'negative', title: 'rejects b', request: { method: 'POST', path: '/b' }, expected: { status: 400 } };

  it('recovers complete objects when the array is cut off mid-object', () => {
    // Two complete tests, then a third object truncated by the token limit.
    const truncated = `{"tests":[${JSON.stringify(t1)},${JSON.stringify(t2)},{"endpointId":"POST::/c","category":"edge","tit`;
    const out = parseProviderOutput(truncated);
    expect(out).toEqual([t1, t2]);
  });

  it('recovers from a bare array truncated after the last complete element', () => {
    const truncated = `[${JSON.stringify(t1)},${JSON.stringify(t2)},`;
    expect(parseProviderOutput(truncated)).toEqual([t1, t2]);
  });

  it('salvages objects containing nested objects/arrays correctly', () => {
    const withSchema = {
      endpointId: 'GET::/x',
      category: 'positive',
      title: 'x',
      request: { method: 'GET', path: '/x', query: { page: 1 } },
      expected: { status: 200, jsonSchema: { type: 'object', properties: { id: { type: 'string' } } }, contains: ['ok'] }
    };
    const truncated = `{"tests":[${JSON.stringify(withSchema)},{"endpointId":"GET::/y","req`;
    expect(parseProviderOutput(truncated)).toEqual([withSchema]);
  });

  it('still throws when not even one complete object can be recovered', () => {
    expect(() => parseProviderOutput('{"tests":[{"endpointId":"POST::/a","ti')).toThrow(/truncated/i);
  });
});

describe('computeMaxOutputTokens', () => {
  it('floors at 8000 for small batches', () => {
    expect(computeMaxOutputTokens(1)).toBe(8000);
    expect(computeMaxOutputTokens(6)).toBe(8000);
  });

  it('scales with batch size between the floor and ceiling', () => {
    expect(computeMaxOutputTokens(8)).toBe(9600);
    expect(computeMaxOutputTokens(10)).toBe(12000);
  });

  it('ceilings at 16000 (OpenAI gpt-4o completion cap)', () => {
    expect(computeMaxOutputTokens(20)).toBe(16000);
    expect(computeMaxOutputTokens(100)).toBe(16000);
  });
});
