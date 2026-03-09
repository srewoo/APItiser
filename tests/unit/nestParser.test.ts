import { describe, expect, it } from 'vitest';
import { parseNestRoutes } from '@background/parser/nestParser';

describe('parseNestRoutes', () => {
  it('extracts routes from controller and method decorators', () => {
    const endpoints = parseNestRoutes([
      {
        path: 'src/users/users.controller.ts',
        content: `
          import { Controller, Get, Post } from '@nestjs/common';
          @Controller('users')
          export class UsersController {
            @Get(':id')
            findOne() {}

            @Post()
            create() {}
          }
        `
      }
    ]);

    expect(endpoints).toHaveLength(2);
    expect(endpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/users/:id')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/users')).toBe(true);
  });
});
