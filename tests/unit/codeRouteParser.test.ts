import { describe, expect, it } from 'vitest';
import { parseCodeRoutes } from '@background/parser/codeRouteParser';

describe('parseCodeRoutes', () => {
  it('resolves mounted express routers across files and dynamic constants', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/routes/users.ts',
        content: `
          import { Router } from 'express';
          const BASE = '/users';
          const router = Router();
          router.get(\`\${BASE}/:id\`, handler);
          export default router;
        `
      },
      {
        path: 'src/app.ts',
        content: `
          import express from 'express';
          import usersRouter from './routes/users';
          const app = express();
          app.use('/v1', usersRouter);
        `
      }
    ]);

    const mounted = endpoints.find((endpoint) => endpoint.method === 'GET' && endpoint.path === '/v1/users/:id');
    expect(mounted).toBeTruthy();
    expect(mounted?.source).toBe('express');
    expect(mounted?.confidence).toBeGreaterThan(0.7);
    expect((mounted?.evidence?.length ?? 0) > 1).toBe(true);
  });

  it('detects koa, hono, and nextjs routes', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/koa-routes.ts',
        content: `
          import Router from '@koa/router';
          const router = new Router();
          router.post('/orders', handler);
        `
      },
      {
        path: 'src/hono-routes.ts',
        content: `
          import { Hono } from 'hono';
          const app = new Hono();
          app.get('/health', (c) => c.text('ok'));
        `
      },
      {
        path: 'app/api/users/[id]/route.ts',
        content: `
          export async function GET() { return Response.json({ ok: true }); }
          export async function DELETE() { return Response.json({ ok: true }); }
        `
      }
    ]);

    expect(endpoints.some((endpoint) => endpoint.source === 'koa' && endpoint.path === '/orders')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.source === 'hono' && endpoint.path === '/health')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.source === 'nextjs' && endpoint.method === 'GET' && endpoint.path === '/api/users/:id')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.source === 'nextjs' && endpoint.method === 'DELETE' && endpoint.path === '/api/users/:id')).toBe(true);
  });

  it('detects python fastapi and flask routes', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'py/fastapi_app.py',
        content: `
          from fastapi import FastAPI
          app = FastAPI()
          @app.get("/users/{id}")
          def get_user(id: str):
            return {}
        `
      },
      {
        path: 'py/flask_app.py',
        content: `
          from flask import Flask
          app = Flask(__name__)
          @app.route("/orders", methods=["GET", "POST"])
          def orders():
            return {}
        `
      }
    ]);

    expect(endpoints.some((endpoint) => endpoint.source === 'fastapi' && endpoint.path === '/users/:id')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.source === 'flask' && endpoint.method === 'GET' && endpoint.path === '/orders')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.source === 'flask' && endpoint.method === 'POST' && endpoint.path === '/orders')).toBe(true);
  });

  it('detects chained express route declarations', () => {
    const endpoints = parseCodeRoutes([
      {
        path: 'src/routes/users.ts',
        content: `
          import { Router } from 'express';
          const router = Router();
          router.route('/users/:id')
            .get(getUser)
            .patch(updateUser);
        `
      }
    ]);

    expect(endpoints.some((endpoint) => endpoint.source === 'express' && endpoint.method === 'GET' && endpoint.path === '/users/:id')).toBe(true);
    expect(endpoints.some((endpoint) => endpoint.source === 'express' && endpoint.method === 'PATCH' && endpoint.path === '/users/:id')).toBe(true);
  });
});
