import { describe, expect, it } from 'vitest';
import { parseApiMap } from '@background/parser/apiParser';

describe('parseApiMap', () => {
  it('combines parsers and deduplicates by method/path', () => {
    const endpoints = parseApiMap([
      {
        path: 'src/app.ts',
        content: "app.get('/health', handler); fastify.get('/users', handler);"
      },
      {
        path: 'src/users.controller.ts',
        content: "import { Controller, Get } from '@nestjs/common'; @Controller('users') class C { @Get(':id') x(){} }"
      }
    ]);

    expect(endpoints.some((endpoint) => endpoint.path === '/health')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.path === '/users')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.path === '/users/:id')).toBe(true);
  });
});
