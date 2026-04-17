import { describe, expect, it } from 'vitest';
import {
  DownloadError,
  GenerationError,
  isApitiserError,
  PackagingError,
  ParseError,
  ScanError,
  ValidationError
} from '@background/errors';

describe('typed error classes', () => {
  it('ScanError carries stage=scan and optional context', () => {
    const err = new ScanError('rate limit hit', { contextId: 'tab-1', repo: 'acme/api' });
    expect(err.message).toBe('rate limit hit');
    expect(err.name).toBe('ScanError');
    expect(err.context.stage).toBe('scan');
    expect(err.context.contextId).toBe('tab-1');
    expect(err.context.repo).toBe('acme/api');
    expect(err).toBeInstanceOf(Error);
  });

  it('ParseError carries stage=parse', () => {
    const err = new ParseError('malformed YAML');
    expect(err.context.stage).toBe('parse');
    expect(err.name).toBe('ParseError');
  });

  it('GenerationError carries batchIndex and provider context', () => {
    const err = new GenerationError('LLM timeout', { batchIndex: 2, provider: 'openai', endpointId: 'GET::/users' });
    expect(err.context.stage).toBe('generation');
    expect(err.context.batchIndex).toBe(2);
    expect(err.context.provider).toBe('openai');
    expect(err.context.endpointId).toBe('GET::/users');
  });

  it('ValidationError carries endpointId and testTitle', () => {
    const err = new ValidationError('status mismatch', { endpointId: 'POST::/items', testTitle: 'creates item' });
    expect(err.context.stage).toBe('validation');
    expect(err.context.endpointId).toBe('POST::/items');
    expect(err.context.testTitle).toBe('creates item');
  });

  it('PackagingError carries stage=packaging', () => {
    const err = new PackagingError('zip failed');
    expect(err.context.stage).toBe('packaging');
  });

  it('DownloadError carries artifactId', () => {
    const err = new DownloadError('artifact not found', { artifactId: 'art-123' });
    expect(err.context.stage).toBe('download');
    expect(err.context.artifactId).toBe('art-123');
  });

  it('isApitiserError returns true for all typed errors', () => {
    expect(isApitiserError(new ScanError('x'))).toBe(true);
    expect(isApitiserError(new ParseError('x'))).toBe(true);
    expect(isApitiserError(new GenerationError('x'))).toBe(true);
    expect(isApitiserError(new ValidationError('x'))).toBe(true);
    expect(isApitiserError(new PackagingError('x'))).toBe(true);
    expect(isApitiserError(new DownloadError('x'))).toBe(true);
  });

  it('isApitiserError returns false for plain errors and non-errors', () => {
    expect(isApitiserError(new Error('plain'))).toBe(false);
    expect(isApitiserError('string error')).toBe(false);
    expect(isApitiserError(null)).toBe(false);
    expect(isApitiserError(undefined)).toBe(false);
    expect(isApitiserError(42)).toBe(false);
  });

  it('errors are instanceof their own class and Error', () => {
    const err = new GenerationError('test');
    expect(err instanceof GenerationError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ScanError).toBe(false);
  });
});
