import { describe, expect, it } from 'vitest';
import { suggestFramework } from '@background/generation/frameworkSuggest';
import { makeEndpoint } from '@shared/testing/factories';

describe('suggestFramework', () => {
  it('should suggest pytest when FastAPI/Flask/Django dominate', () => {
    const endpoints = [
      makeEndpoint({ source: 'fastapi' }),
      makeEndpoint({ source: 'flask' }),
      makeEndpoint({ source: 'express' })
    ];
    expect(suggestFramework(endpoints)).toBe('pytest');
  });

  it('should suggest gotest for any Go router source', () => {
    expect(suggestFramework([makeEndpoint({ source: 'chi' })])).toBe('gotest');
    expect(suggestFramework([makeEndpoint({ source: 'echo' })])).toBe('gotest');
    expect(suggestFramework([makeEndpoint({ source: 'mux' })])).toBe('gotest');
    expect(suggestFramework([makeEndpoint({ source: 'nethttp' })])).toBe('gotest');
    expect(suggestFramework([makeEndpoint({ source: 'gin' })])).toBe('gotest');
  });

  it('should suggest restassured for Spring and JAX-RS', () => {
    expect(suggestFramework([makeEndpoint({ source: 'spring' })])).toBe('restassured');
    expect(suggestFramework([makeEndpoint({ source: 'jaxrs' })])).toBe('restassured');
  });

  it('should suggest supertest for the Express family', () => {
    expect(suggestFramework([makeEndpoint({ source: 'express' })])).toBe('supertest');
    expect(suggestFramework([makeEndpoint({ source: 'nestjs' })])).toBe('supertest');
  });

  it('should return undefined when only OpenAPI-sourced endpoints exist', () => {
    expect(suggestFramework([makeEndpoint({ source: 'openapi' })])).toBeUndefined();
  });

  it('should return undefined for an empty endpoint list', () => {
    expect(suggestFramework([])).toBeUndefined();
  });

  it('should respect sourceMetadata.sources when present', () => {
    const endpoint = makeEndpoint({
      source: 'openapi',
      sourceMetadata: {
        sources: ['openapi', 'spring'],
        hasExistingTests: false,
        mergedFromOpenApi: true,
        mergedFromCode: true,
        inferredFromExamples: false
      }
    });
    expect(suggestFramework([endpoint])).toBe('restassured');
  });
});
