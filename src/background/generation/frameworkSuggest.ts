import type { ApiEndpoint, EndpointSource, TestFramework } from '@shared/types';

/**
 * Maps a detected route source to the most idiomatic test framework for that stack.
 * OpenAPI is intentionally omitted — it is language-agnostic and should not drive the
 * suggestion on its own.
 */
const SOURCE_TO_FRAMEWORK: Partial<Record<EndpointSource, TestFramework>> = {
  express: 'supertest',
  fastify: 'supertest',
  koa: 'supertest',
  hono: 'supertest',
  nestjs: 'supertest',
  nextjs: 'jest',
  fastapi: 'pytest',
  flask: 'pytest',
  django: 'pytest',
  spring: 'restassured',
  jaxrs: 'restassured',
  gin: 'gotest',
  chi: 'gotest',
  echo: 'gotest',
  mux: 'gotest',
  nethttp: 'gotest'
};

/**
 * Suggests a test framework based on the dominant detected source across endpoints.
 * Returns undefined when there is no language signal (e.g. only OpenAPI-sourced endpoints),
 * so callers can fall back to the user's current selection.
 */
export const suggestFramework = (endpoints: ApiEndpoint[]): TestFramework | undefined => {
  const votes = new Map<TestFramework, number>();

  for (const endpoint of endpoints) {
    const sources = endpoint.sourceMetadata?.sources?.length
      ? endpoint.sourceMetadata.sources
      : [endpoint.source];
    for (const source of sources) {
      const framework = SOURCE_TO_FRAMEWORK[source];
      if (framework) {
        votes.set(framework, (votes.get(framework) ?? 0) + 1);
      }
    }
  }

  if (votes.size === 0) {
    return undefined;
  }

  let best: TestFramework | undefined;
  let bestCount = -1;
  for (const [framework, count] of votes) {
    if (count > bestCount) {
      best = framework;
      bestCount = count;
    }
  }
  return best;
};
