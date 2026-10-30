import { describe, expect, it } from 'vitest';
import { parsePythonRoutes } from '@background/parser/languages/python';
import type { RepoFile } from '@shared/types';

const f = (path: string, lines: string[]): RepoFile => {
  const content = lines.join('\n');
  return { path, content, size: content.length };
};
const routes = (files: RepoFile[]) => parsePythonRoutes(files).map((r) => `${r.method} ${r.path}`).sort();

const usersModule = (path: string) =>
  f(path, ['from fastapi import APIRouter', 'router = APIRouter(tags=["users"])', '@router.get("/users/{user_id}")', 'def get_user(user_id: int): ...']);

describe('FastAPI routers mounted from other files', () => {
  it('applies the parent router prefix (from pkg import module as alias)', () => {
    const server = f('backend/server.py', [
      'from fastapi import FastAPI, APIRouter',
      'app = FastAPI()',
      'api_router = APIRouter(prefix="/api")',
      'from api.routes import users as _users',
      'api_router.include_router(_users.router)',
      '@api_router.get("/health")',
      'def health(): ...',
      'app.include_router(api_router)'
    ]);
    expect(routes([server, usersModule('backend/api/routes/users.py')])).toEqual(['GET /api/health', 'GET /api/users/:user_id']);
  });

  it('stacks include prefixes, own prefixes and nested mounts (import x as y, from mod import router)', () => {
    const main = f('app/main.py', [
      'from fastapi import FastAPI',
      'import app.v1 as v1',
      'app = FastAPI()',
      'app.include_router(v1.router, prefix="/api")'
    ]);
    const v1 = f('app/v1.py', [
      'from fastapi import APIRouter',
      'from .users import router as users_router',
      'router = APIRouter(prefix="/v1")',
      'router.include_router(users_router, prefix="/accounts")'
    ]);
    expect(routes([main, v1, usersModule('app/users.py')])).toEqual(['GET /api/v1/accounts/users/:user_id']);
  });

  it('leaves unmounted routers and their own prefixes unchanged', () => {
    const solo = f('svc.py', ['from fastapi import APIRouter', 'router = APIRouter(prefix="/items")', '@router.get("/")', 'def list_items(): ...']);
    expect(routes([solo])).toEqual(['GET /items']);
  });

  it('ignores include_router examples in docstrings', () => {
    const server = f('server.py', [
      'from fastapi import FastAPI, APIRouter',
      'app = FastAPI()',
      'api_router = APIRouter(prefix="/api")',
      'from api.routes import users as _users',
      '"""Example: other.include_router(_users.router, prefix="/wrong")"""',
      'api_router.include_router(_users.router)'
    ]);
    expect(routes([server, usersModule('api/routes/users.py')])).toEqual(['GET /api/users/:user_id']);
  });
});
