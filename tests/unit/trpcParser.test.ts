import { describe, expect, it } from 'vitest';
import { parseTrpcEndpoints } from '@background/parser/languages/trpc';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

describe('parseTrpcEndpoints', () => {
  it('maps queries to GET and mutations to POST under /trpc', () => {
    const file = makeFile(
      'router.ts',
      `import { z } from 'zod';
export const appRouter = router({
  getUser: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => input),
  createUser: publicProcedure.input(z.object({ name: z.string(), age: z.number().optional() })).mutation(({ input }) => input),
});
`
    );

    const endpoints = parseTrpcEndpoints([file]);
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((e) => e.source === 'trpc')).toBe(true);

    const getUser = endpoints.find((e) => e.operationId === 'getUser');
    expect(getUser?.method).toBe('GET');
    expect(getUser?.path).toBe('/trpc/getUser');
    expect(getUser?.queryParams.some((p) => p.name === 'id')).toBe(true);

    const createUser = endpoints.find((e) => e.operationId === 'createUser');
    expect(createUser?.method).toBe('POST');
    expect(createUser?.path).toBe('/trpc/createUser');
    expect(createUser?.body?.properties?.name).toBeDefined();
    // z.number() → integer, optional → not required
    expect((createUser?.body?.properties?.age as { type: string }).type).toBe('integer');
    expect(createUser?.body?.required).toEqual(['name']);
  });

  it('builds dotted paths through nested routers', () => {
    const file = makeFile(
      'app.ts',
      `export const appRouter = t.router({
  user: t.router({
    list: protectedProcedure.query(() => []),
    remove: protectedProcedure.input(z.object({ id: z.string() })).mutation(() => null),
  }),
  health: publicProcedure.query(() => 'ok'),
});
`
    );

    const endpoints = parseTrpcEndpoints([file]);
    const paths = endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual(['GET /trpc/health', 'GET /trpc/user.list', 'POST /trpc/user.remove']);
  });

  it('ignores files without tRPC routers', () => {
    expect(parseTrpcEndpoints([makeFile('x.ts', 'export const y = 1;')])).toHaveLength(0);
  });
});
