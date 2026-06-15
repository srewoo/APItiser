import { describe, expect, it } from 'vitest';
import { parsePythonRoutes } from '@background/parser/languages/python';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

// ---------------------------------------------------------------------------
// Prefixes: FastAPI APIRouter(prefix=...) and Flask Blueprint(url_prefix=...)
// ---------------------------------------------------------------------------

describe('parsePythonRoutes — prefixes', () => {
  it('prepends APIRouter prefix to FastAPI routes declared on that router', () => {
    const file = makeFile(
      'app/items.py',
      `
from fastapi import APIRouter

router = APIRouter(prefix="/v1")

@router.get("/items")
async def list_items():
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/v1/items', source: 'fastapi', owner: 'router' });
  });

  it('prepends Blueprint url_prefix to Flask routes declared on that blueprint', () => {
    const file = makeFile(
      'app/views.py',
      `
from flask import Blueprint

bp = Blueprint("api", __name__, url_prefix="/api")

@bp.get("/items")
def get_items():
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/items', source: 'flask', owner: 'bp' });
  });

  it('applies Blueprint url_prefix to @route methods declarations', () => {
    const file = makeFile(
      'app/views.py',
      `
from flask import Blueprint

bp = Blueprint("api", __name__, url_prefix="/api")

@bp.route("/products", methods=["GET", "POST"])
def products():
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.path)).toEqual(['/api/products', '/api/products']);
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });
});

// ---------------------------------------------------------------------------
// Multi-line decorators
// ---------------------------------------------------------------------------

describe('parsePythonRoutes — multi-line decorators', () => {
  it('detects a route whose decorator spans multiple lines', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI
app = FastAPI()

@app.get(
    "/items",
    response_model=ItemList,
)
async def list_items():
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/items' });
  });
});

// ---------------------------------------------------------------------------
// FastAPI query / path param extraction from the handler signature
// ---------------------------------------------------------------------------

describe('parsePythonRoutes — FastAPI signature model', () => {
  it('extracts typed query params from the handler signature', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI
app = FastAPI()

@app.get("/items")
async def list_items(limit: int = 10, q: str = None, active: bool = True):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]?.queryParams).toEqual([
      { name: 'limit', required: false, type: 'integer' },
      { name: 'q', required: false, type: 'string' },
      { name: 'active', required: false, type: 'boolean' }
    ]);
  });

  it('marks a query param without a default as required', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI
app = FastAPI()

@app.get("/search")
async def search(term: str, page: int = 1):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]?.queryParams).toEqual([
      { name: 'term', required: true, type: 'string' },
      { name: 'page', required: false, type: 'integer' }
    ]);
  });

  it('types path params from the signature annotation', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI
app = FastAPI()

@app.get("/users/{user_id}")
async def get_user(user_id: int):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]?.path).toBe('/users/:user_id');
    expect(routes[0]?.pathParams).toEqual([{ name: 'user_id', required: true, type: 'integer' }]);
    // The path param must NOT leak into query params.
    expect(routes[0]?.queryParams ?? []).toEqual([]);
  });

  it('skips self, request, db and Depends() params', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI, Depends
app = FastAPI()

@app.get("/me")
async def me(request, db = Depends(get_db), limit: int = 5):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]?.queryParams).toEqual([{ name: 'limit', required: false, type: 'integer' }]);
  });
});

// ---------------------------------------------------------------------------
// FastAPI Pydantic request body on write methods
// ---------------------------------------------------------------------------

describe('parsePythonRoutes — FastAPI Pydantic body', () => {
  it('treats a Pydantic-model param as the request body on POST', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI
app = FastAPI()

@app.post("/users")
async def create_user(payload: UserCreate):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]).toMatchObject({ method: 'POST', path: '/users' });
    expect(routes[0]?.body).toBeDefined();
    expect(routes[0]?.body?.type).toBe('object');
    expect(routes[0]?.body?.properties).toHaveProperty('payload');
    // A model param is not a query param.
    expect(routes[0]?.queryParams ?? []).toEqual([]);
  });

  it('does not treat a Pydantic-model param as a body on GET', () => {
    const file = makeFile(
      'app/main.py',
      `
from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def list_users(filters: UserFilter):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes[0]?.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Flask methods array (kept working)
// ---------------------------------------------------------------------------

describe('parsePythonRoutes — Flask methods array', () => {
  it('expands a methods=[...] route into one signal per method', () => {
    const file = makeFile(
      'app/views.py',
      `
@app.route("/products", methods=["GET", "POST"])
def products():
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    expect(routes[0]?.path).toBe('/products');
  });
});

// ---------------------------------------------------------------------------
// Django urls.py + DRF
// ---------------------------------------------------------------------------

describe('parsePythonRoutes — Django', () => {
  it('detects path() entries and types <int:pk> as integer', () => {
    const file = makeFile(
      'app/urls.py',
      `
from django.urls import path
from . import views

urlpatterns = [
    path("api/items/", views.items),
    path("api/items/<int:pk>/", views.item_detail),
    path("api/tags/<slug:name>/", views.tag),
]
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(3);
    expect(routes.every((r) => r.source === 'django')).toBe(true);
    expect(routes.every((r) => r.method === 'GET')).toBe(true);

    const detail = routes.find((r) => r.path === '/api/items/:pk/');
    expect(detail).toBeDefined();
    expect(detail?.pathParams).toEqual([{ name: 'pk', required: true, type: 'integer' }]);
    expect(detail?.confidence).toBe(0.9);

    const tag = routes.find((r) => r.path === '/api/tags/:name/');
    expect(tag?.pathParams).toEqual([{ name: 'name', required: true, type: 'string' }]);
  });

  it('detects re_path() entries with regex anchors stripped', () => {
    const file = makeFile(
      'app/urls.py',
      `
from django.urls import re_path
urlpatterns = [
    re_path(r"^api/legacy/$", views.legacy),
]
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/legacy/', source: 'django' });
  });

  it('detects DRF @api_view methods', () => {
    const file = makeFile(
      'app/views.py',
      `
from rest_framework.decorators import api_view

@api_view(["GET", "POST"])
def items(request):
    pass
`
    );
    const routes = parsePythonRoutes([file]);
    expect(routes.filter((r) => r.source === 'django')).toHaveLength(2);
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });
});
