import { describe, expect, it } from 'vitest';
import { parseExpressRoutes } from '@background/parser/expressParser';

describe('parseExpressRoutes', () => {
  it('extracts app and router routes with params', () => {
    const endpoints = parseExpressRoutes([
      {
        path: 'src/routes/users.ts',
        content: `
          app.get('/users', handler)
          router.post('/users/:id/reset', handler)
        `
      }
    ]);

    expect(endpoints).toHaveLength(2);
    expect(endpoints[0].method).toBe('GET');
    expect(endpoints[1].pathParams[0].name).toBe('id');
  });
});
