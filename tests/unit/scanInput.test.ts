import { describe, expect, it } from 'vitest';
import { applyOpenApiFallback } from '@background/parser/scanInput';

describe('applyOpenApiFallback', () => {
  it('returns original files when no fallback spec is provided', () => {
    const input = [{ path: 'src/app.ts', content: 'app.get("/health")' }];
    const result = applyOpenApiFallback(input, '   ');

    expect(result.usedFallback).toBe(false);
    expect(result.files).toHaveLength(1);
  });

  it('adds json fallback file when spec starts with json object', () => {
    const result = applyOpenApiFallback([], '{"openapi":"3.0.0"}');

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackPath).toBe('openapi.manual.json');
    expect(result.files[0].path).toBe('openapi.manual.json');
  });

  it('updates existing fallback file rather than duplicating', () => {
    const result = applyOpenApiFallback(
      [{ path: 'openapi.manual.yaml', content: 'openapi: 3.0.0' }],
      'openapi: 3.1.0'
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toBe('openapi: 3.1.0');
  });
});
