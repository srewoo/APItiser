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

  it('builds canonical endpoints with trust and existing-test auth hints', () => {
    const endpoints = parseApiMap([
      {
        path: 'src/app.ts',
        content: "app.get('/users/:id', handler);"
      },
      {
        path: 'openapi.yaml',
        content: `
openapi: 3.0.0
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
paths:
  /users/{id}:
    get:
      security:
        - bearerAuth: []
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id:
                    type: integer
`
      },
      {
        path: 'tests/users.test.ts',
        content: "await request(app).get('/users/1').set('Authorization', 'Bearer test-token');"
      }
    ]);

    const endpoint = endpoints.find((item) => item.id === 'GET::/users/:id');
    expect(endpoint?.trustScore).toBeGreaterThan(70);
    expect(endpoint?.trustLabel).toBe('high');
    expect(endpoint?.authHints?.some((hint) => hint.headerName === 'Authorization')).toBe(true);
    expect(endpoint?.sourceMetadata?.hasExistingTests).toBe(true);
    expect(endpoint?.responses[0]?.schema?.type).toBe('object');
  });
});
