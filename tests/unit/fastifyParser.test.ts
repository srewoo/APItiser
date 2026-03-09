import { describe, expect, it } from 'vitest';
import { parseFastifyRoutes } from '@background/parser/fastifyParser';

describe('parseFastifyRoutes', () => {
  it('extracts shorthand and route-object fastify routes', () => {
    const endpoints = parseFastifyRoutes([
      {
        path: 'src/server.ts',
        content: `
          fastify.get('/users/:id', handler)
          app.route({ method: 'POST', url: '/orders', handler })
        `
      }
    ]);

    expect(endpoints).toHaveLength(2);
    expect(endpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/users/:id')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/orders')).toBe(true);
  });
});
