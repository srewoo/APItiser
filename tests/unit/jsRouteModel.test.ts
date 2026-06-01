import { describe, expect, it } from 'vitest';
import { parseCodeRoutes } from '@background/parser/codeRouteParser';

describe('JS/TS route model extraction', () => {
  it('recovers body fields from express req.body destructuring', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/users.ts',
        content: `
          import express from 'express';
          const app = express();
          app.post('/users', (req, res) => {
            const { name, email } = req.body;
            res.json({ name, email });
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/users');
    expect(endpoint).toBeTruthy();
    expect(endpoint?.body?.type).toBe('object');
    expect(Object.keys(endpoint?.body?.properties ?? {})).toEqual(expect.arrayContaining(['name', 'email']));
    expect(endpoint?.body?.required).toEqual(expect.arrayContaining(['name', 'email']));
    expect(endpoint?.body?.properties?.name).toMatchObject({ type: 'string', required: true });
  });

  it('recovers body fields from express req.body.field member access', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/orders.ts',
        content: `
          import express from 'express';
          const app = express();
          app.post('/orders', (req, res) => {
            const total = req.body.total;
            const sku = req.body.sku;
            res.json({ total, sku });
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/orders');
    expect(endpoint).toBeTruthy();
    expect(Object.keys(endpoint?.body?.properties ?? {})).toEqual(expect.arrayContaining(['total', 'sku']));
  });

  it('recovers query params from express req.query.field', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/list.ts',
        content: `
          import express from 'express';
          const app = express();
          app.get('/items', (req, res) => {
            const page = req.query.page;
            res.json([]);
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'GET' && e.path === '/items');
    expect(endpoint).toBeTruthy();
    expect(endpoint?.queryParams.map((q) => q.name)).toContain('page');
    expect(endpoint?.queryParams.find((q) => q.name === 'page')).toMatchObject({ required: false, type: 'string' });
  });

  it('recovers query params from express req.query destructuring', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/search.ts',
        content: `
          import express from 'express';
          const app = express();
          app.get('/search', (req, res) => {
            const { q, limit } = req.query;
            res.json([]);
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'GET' && e.path === '/search');
    expect(endpoint?.queryParams.map((q) => q.name)).toEqual(expect.arrayContaining(['q', 'limit']));
  });

  it('recovers Hono query() and json() body signals', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/hono.ts',
        content: `
          import { Hono } from 'hono';
          const app = new Hono();
          app.post('/notes', async (c) => {
            const author = c.req.query('author');
            const { title, content } = await c.req.json();
            return c.json({ ok: true });
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/notes');
    expect(endpoint).toBeTruthy();
    expect(endpoint?.queryParams.map((q) => q.name)).toContain('author');
    expect(Object.keys(endpoint?.body?.properties ?? {})).toEqual(expect.arrayContaining(['title', 'content']));
  });

  it('recovers koa ctx.request.body destructuring', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/koa.ts',
        content: `
          import Router from '@koa/router';
          const router = new Router();
          router.post('/login', async (ctx) => {
            const { username, password } = ctx.request.body;
            ctx.body = { ok: true };
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/login');
    expect(endpoint).toBeTruthy();
    expect(Object.keys(endpoint?.body?.properties ?? {})).toEqual(expect.arrayContaining(['username', 'password']));
  });

  it('recovers Fastify schema.body and schema.querystring from route options', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/fastify.ts',
        content: `
          import fastify from 'fastify';
          const app = fastify();
          app.post('/products', {
            schema: {
              body: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  price: { type: 'number' },
                  inStock: { type: 'boolean' }
                }
              },
              querystring: {
                type: 'object',
                properties: {
                  category: { type: 'string' }
                }
              }
            }
          }, async (req, reply) => {
            return { ok: true };
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/products');
    expect(endpoint).toBeTruthy();
    expect(Object.keys(endpoint?.body?.properties ?? {})).toEqual(expect.arrayContaining(['name', 'price', 'inStock']));
    expect(endpoint?.body?.required).toEqual(['name']);
    expect(endpoint?.body?.properties?.price).toMatchObject({ type: 'number' });
    expect(endpoint?.queryParams.map((q) => q.name)).toContain('category');
  });

  it('recovers Fastify schema via fastify.route() declaration', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/fastifyRoute.ts',
        content: `
          import fastify from 'fastify';
          const app = fastify();
          app.route({
            method: 'PUT',
            url: '/account',
            schema: {
              body: {
                type: 'object',
                properties: { displayName: { type: 'string' } }
              }
            },
            handler: async () => ({ ok: true })
          });
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'PUT' && e.path === '/account');
    expect(endpoint).toBeTruthy();
    expect(Object.keys(endpoint?.body?.properties ?? {})).toContain('displayName');
  });

  it('recovers NestJS @Body with in-file DTO and @Query/@Param', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/users.controller.ts',
        content: `
          import { Controller, Post, Get, Body, Query, Param } from '@nestjs/common';

          class CreateUserDto {
            name: string;
            age: number;
            verified: boolean;
            nickname?: string;
          }

          @Controller('users')
          class UsersController {
            @Post()
            create(@Body() dto: CreateUserDto) {
              return dto;
            }

            @Get(':id')
            findOne(@Param('id') id: string, @Query('expand') expand: string) {
              return { id };
            }
          }
        `
      }
    ]);

    const createEndpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/users');
    expect(createEndpoint).toBeTruthy();
    expect(Object.keys(createEndpoint?.body?.properties ?? {})).toEqual(
      expect.arrayContaining(['name', 'age', 'verified', 'nickname'])
    );
    expect(createEndpoint?.body?.properties?.age).toMatchObject({ type: 'number' });
    expect(createEndpoint?.body?.properties?.verified).toMatchObject({ type: 'boolean' });
    // optional DTO field should not be required
    expect(createEndpoint?.body?.required ?? []).not.toContain('nickname');

    const getEndpoint = endpoints.find((e) => e.method === 'GET' && e.path === '/users/:id');
    expect(getEndpoint).toBeTruthy();
    expect(getEndpoint?.queryParams.map((q) => q.name)).toContain('expand');
    expect(getEndpoint?.pathParams.map((p) => p.name)).toContain('id');
  });

  it('falls back to generic object body when NestJS DTO is not in-file', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/orders.controller.ts',
        content: `
          import { Controller, Post, Body } from '@nestjs/common';
          import { CreateOrderDto } from './dto';

          @Controller('orders')
          class OrdersController {
            @Post()
            create(@Body() dto: CreateOrderDto) {
              return dto;
            }
          }
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'POST' && e.path === '/orders');
    expect(endpoint).toBeTruthy();
    expect(endpoint?.body?.type).toBe('object');
    expect(endpoint?.body?.properties).toBeUndefined();
  });

  it('leaves body unset when handler reads nothing', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/health.ts',
        content: `
          import express from 'express';
          const app = express();
          app.get('/health', (req, res) => res.json({ ok: true }));
        `
      }
    ]);

    const endpoint = endpoints.find((e) => e.method === 'GET' && e.path === '/health');
    expect(endpoint).toBeTruthy();
    expect(endpoint?.body).toBeUndefined();
    expect(endpoint?.queryParams).toEqual([]);
  });
});
