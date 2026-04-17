import { describe, expect, it } from 'vitest';
import { parseProviderOutput } from '@background/llm/promptBuilder';

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
