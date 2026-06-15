import { describe, expect, it } from 'vitest';
import { parseGoRoutes } from '@background/parser/languages/go';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

// ---------------------------------------------------------------------------
// Gin — nested (multi-level) groups
// ---------------------------------------------------------------------------

describe('parseGoRoutes — gin nested groups', () => {
  it('resolves a two-level group chain to the full prefix', () => {
    const file = makeFile(
      'main.go',
      `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.Default()
    api := r.Group("/api")
    v1 := api.Group("/v1")
    v1.GET("/users", listUsers)
    v1.POST("/users", createUser)
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/v1/users', source: 'gin' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/api/v1/users', source: 'gin' });
  });

  it('still handles single-level groups', () => {
    const file = makeFile(
      'main.go',
      `
import "github.com/gin-gonic/gin"
v1 := r.Group("/api/v1")
v1.DELETE("/users/:id", deleteUser)
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/users/:id', source: 'gin' });
  });
});

// ---------------------------------------------------------------------------
// chi
// ---------------------------------------------------------------------------

describe('parseGoRoutes — chi', () => {
  it('detects capitalised method calls', () => {
    const file = makeFile(
      'routes.go',
      `
package main

import "github.com/go-chi/chi/v5"

func routes() {
    r := chi.NewRouter()
    r.Get("/health", healthHandler)
    r.Post("/users", createUser)
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/health', source: 'chi' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/users', source: 'chi' });
  });

  it('applies Route prefixes to nested method calls and converts {id} to :id', () => {
    const file = makeFile(
      'routes.go',
      `
import "github.com/go-chi/chi/v5"

func routes() {
    r := chi.NewRouter()
    r.Route("/api", func(r chi.Router) {
        r.Route("/users", func(r chi.Router) {
            r.Get("/{id}", getUser)
            r.Delete("/{id}", deleteUser)
        })
    })
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/api/users/:id', source: 'chi' });
    expect(routes[1]).toMatchObject({ method: 'DELETE', path: '/api/users/:id', source: 'chi' });
  });
});

// ---------------------------------------------------------------------------
// echo
// ---------------------------------------------------------------------------

describe('parseGoRoutes — echo', () => {
  it('detects echo group-prefixed routes', () => {
    const file = makeFile(
      'server.go',
      `
package main

import "github.com/labstack/echo/v4"

func main() {
    e := echo.New()
    e.GET("/ping", ping)
    g := e.Group("/api")
    g.GET("/users/:id", getUser)
    g.POST("/users", createUser)
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(3);
    expect(routes.map((r) => r.source)).toEqual(['echo', 'echo', 'echo']);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/ping' });
    expect(routes[1]).toMatchObject({ method: 'GET', path: '/api/users/:id' });
    expect(routes[2]).toMatchObject({ method: 'POST', path: '/api/users' });
  });
});

// ---------------------------------------------------------------------------
// gorilla/mux
// ---------------------------------------------------------------------------

describe('parseGoRoutes — gorilla/mux', () => {
  it('emits one signal per method on .Methods()', () => {
    const file = makeFile(
      'router.go',
      `
package main

import "github.com/gorilla/mux"

func setup() {
    r := mux.NewRouter()
    r.HandleFunc("/products", productsHandler).Methods("GET", "POST")
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(2);
    const methods = routes.map((r) => r.method).sort();
    expect(methods).toEqual(['GET', 'POST']);
    expect(routes.every((r) => r.path === '/products' && r.source === 'mux')).toBe(true);
  });

  it('resolves http.MethodGet constants and strips {id:[0-9]+} regex to :id (integer typed)', () => {
    const file = makeFile(
      'router.go',
      `
import "github.com/gorilla/mux"

func setup() {
    r := mux.NewRouter()
    r.HandleFunc("/items/{id:[0-9]+}", itemHandler).Methods(http.MethodGet)
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/items/:id', source: 'mux' });
    expect(routes[0]?.pathParams).toEqual([{ name: 'id', required: true, type: 'integer' }]);
  });
});

// ---------------------------------------------------------------------------
// net/http ServeMux (Go 1.22 pattern routing)
// ---------------------------------------------------------------------------

describe('parseGoRoutes — net/http pattern routing', () => {
  it('detects "METHOD /path/{param}" patterns', () => {
    const file = makeFile(
      'handlers.go',
      `
package main

import "net/http"

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("GET /items/{id}", getItem)
    http.HandleFunc("POST /items", createItem)
}
`
    );
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/items/:id', source: 'nethttp' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/items', source: 'nethttp' });
  });
});

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------

describe('parseGoRoutes — file filtering', () => {
  it('ignores non-go files', () => {
    const file = makeFile('main.ts', `r.GET("/users", handler)`);
    expect(parseGoRoutes([file])).toHaveLength(0);
  });
});
