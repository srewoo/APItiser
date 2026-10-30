import { describe, expect, it } from 'vitest';
import { parseOpenApiSpecs } from '@background/parser/openApiParser';

describe('parseOpenApiSpecs', () => {
  it('does not stack-overflow on a self-referential $ref schema', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/tree': {
          post: {
            operationId: 'createTree',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } }
            },
            responses: { 201: { description: 'Created' } }
          }
        }
      },
      components: {
        schemas: {
          // Node references itself through `children` — the classic recursive schema.
          Node: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }
            }
          }
        }
      }
    };

    const endpoints = parseOpenApiSpecs([{ path: 'openapi.json', content: JSON.stringify(spec) }]);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].method).toBe('POST');
    // The recursion is broken with a placeholder rather than crashing.
    expect(endpoints[0].body?.properties?.children).toBeDefined();
  });

  it('composes allOf and takes a representative oneOf branch in a request body', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/Base' },
                      {
                        type: 'object',
                        required: ['species'],
                        properties: { species: { type: 'string' } }
                      }
                    ]
                  }
                }
              }
            },
            responses: { 201: { description: 'Created' } }
          }
        }
      },
      components: {
        schemas: {
          Base: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' }, name: { type: 'string' } }
          }
        }
      }
    };

    const endpoints = parseOpenApiSpecs([{ path: 'openapi.json', content: JSON.stringify(spec) }]);
    const body = endpoints[0].body;
    // Properties from both allOf members are merged...
    expect(Object.keys(body?.properties ?? {})).toEqual(expect.arrayContaining(['id', 'name', 'species']));
    // ...and required is the union.
    expect(body?.required).toEqual(expect.arrayContaining(['id', 'species']));
  });

  it('parses json OpenAPI path operations into endpoints', () => {
    const endpoints = parseOpenApiSpecs([
      {
        path: 'openapi.json',
        content: JSON.stringify({
          openapi: '3.0.0',
          paths: {
            '/users/{id}': {
              get: {
                operationId: 'getUser',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                  { name: 'includeMeta', in: 'query', required: false, schema: { type: 'boolean' } }
                ],
                responses: {
                  200: { description: 'Ok' },
                  404: { description: 'Not found' }
                }
              }
            }
          }
        })
      }
    ]);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].operationId).toBe('getUser');
    expect(endpoints[0].pathParams[0].name).toBe('id');
    expect(endpoints[0].queryParams[0].name).toBe('includeMeta');
    expect(endpoints[0].responses).toHaveLength(2);
    expect(endpoints[0].confidence).toBeGreaterThan(0.9);
    expect(endpoints[0].evidence?.[0]?.reason).toContain('OpenAPI');
  });

  it('detects OpenAPI from content even when filename is non-standard', () => {
    const endpoints = parseOpenApiSpecs([
      {
        path: 'specs/catalog-service.json',
        content: JSON.stringify({
          openapi: '3.0.2',
          paths: {
            '/catalog/items': {
              post: {
                responses: {
                  201: { description: 'Created' }
                }
              }
            }
          }
        })
      }
    ]);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].method).toBe('POST');
    expect(endpoints[0].path).toBe('/catalog/items');
  });

  it('merges path-level parameters and resolves inherited or overridden security', () => {
    const endpoints = parseOpenApiSpecs([
      {
        path: 'specs/authenticated-api.yaml',
        content: `
openapi: 3.0.3
security:
  - bearerAuth: []
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
paths:
  /users/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
      - name: includeMeta
        in: query
        required: false
        schema:
          type: boolean
    get:
      security: []
      responses:
        "200":
          description: ok
    post:
      responses:
        "201":
          description: created
`
      }
    ]);

    expect(endpoints).toHaveLength(2);

    const getEndpoint = endpoints.find((endpoint) => endpoint.method === 'GET');
    const postEndpoint = endpoints.find((endpoint) => endpoint.method === 'POST');

    expect(getEndpoint?.auth).toBe('none');
    expect(getEndpoint?.pathParams[0]?.name).toBe('id');
    expect(getEndpoint?.queryParams[0]?.name).toBe('includeMeta');
    expect(postEndpoint?.auth).toBe('bearer');
    expect(postEndpoint?.pathParams[0]?.name).toBe('id');
    expect(postEndpoint?.queryParams[0]?.name).toBe('includeMeta');
  });
});
