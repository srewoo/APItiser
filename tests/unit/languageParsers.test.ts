import { describe, expect, it } from 'vitest';
import { parsePythonRoutes } from '@background/parser/languages/python';
import { parseGoRoutes } from '@background/parser/languages/go';
import { parseSpringRoutes } from '@background/parser/languages/java';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

// ---------------------------------------------------------------------------
// Python / Flask / FastAPI
// ---------------------------------------------------------------------------

describe('parsePythonRoutes', () => {
  it('detects FastAPI decorator routes', () => {
    const file = makeFile('app/main.py', `
from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def list_users():
    pass

@app.post("/users")
async def create_user():
    pass
`);
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/users', source: 'fastapi' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/users', source: 'fastapi' });
  });

  it('detects Flask decorator routes', () => {
    const file = makeFile('app/views.py', `
from flask import Flask
app = Flask(__name__)

@app.get("/items")
def get_items():
    pass
`);
    const routes = parsePythonRoutes([file]);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/items', source: 'flask' });
  });

  it('detects Flask @route with methods list', () => {
    const file = makeFile('app/views.py', `
@app.route("/products", methods=["GET", "POST"])
def products():
    pass
`);
    const routes = parsePythonRoutes([file]);
    expect(routes).toHaveLength(2);
    const methods = routes.map((r) => r.method).sort();
    expect(methods).toEqual(['GET', 'POST']);
    expect(routes[0]?.path).toBe('/products');
  });

  it('converts curly brace path params to colon style', () => {
    const file = makeFile('main.py', `
@app.get("/users/{user_id}/posts/{post_id}")
async def get_post():
    pass
`);
    const routes = parsePythonRoutes([file]);
    expect(routes[0]?.path).toBe('/users/:user_id/posts/:post_id');
  });

  it('ignores non-python files', () => {
    const file = makeFile('app/views.ts', `@app.get("/users")\nasync function users() {}`);
    expect(parsePythonRoutes([file])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Go / Gin
// ---------------------------------------------------------------------------

describe('parseGoRoutes', () => {
  it('detects simple Gin routes', () => {
    const file = makeFile('main.go', `
package main

import "github.com/gin-gonic/gin"

func main() {
    r := gin.Default()
    r.GET("/ping", func(c *gin.Context) {})
    r.POST("/users", createUser)
    r.DELETE("/users/:id", deleteUser)
}
`);
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(3);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/ping', source: 'gin' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/users', source: 'gin' });
    expect(routes[2]).toMatchObject({ method: 'DELETE', path: '/users/:id', source: 'gin' });
  });

  it('detects group-prefixed routes', () => {
    const file = makeFile('main.go', `
package main

func main() {
    r := gin.Default()
    v1 := r.Group("/api/v1")
    v1.GET("/users", listUsers)
    v1.POST("/users", createUser)
}
`);
    const routes = parseGoRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]?.path).toBe('/api/v1/users');
    expect(routes[1]?.path).toBe('/api/v1/users');
  });

  it('gives higher confidence to routes with group prefix', () => {
    const fileWithGroup = makeFile('main.go', `
v1 := r.Group("/api")
v1.GET("/users", h)
`);
    const fileWithout = makeFile('simple.go', `r.GET("/users", h)`);

    const withGroup = parseGoRoutes([fileWithGroup]);
    const without = parseGoRoutes([fileWithout]);
    expect(withGroup[0]?.confidence).toBeGreaterThan(without[0]?.confidence ?? 0);
  });

  it('ignores non-go files', () => {
    const file = makeFile('main.ts', `r.GET("/users", handler)`);
    expect(parseGoRoutes([file])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Java / Spring
// ---------------------------------------------------------------------------

describe('parseSpringRoutes', () => {
  it('detects GetMapping and PostMapping annotations', () => {
    const file = makeFile('src/UserController.java', `
@RestController
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() { return users; }

    @PostMapping("/users")
    public User createUser() { return user; }
}
`);
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/users', source: 'spring' });
    expect(routes[1]).toMatchObject({ method: 'POST', path: '/users', source: 'spring' });
  });

  it('applies class-level @RequestMapping prefix', () => {
    const file = makeFile('src/UserController.java', `
@RestController
@RequestMapping(value = "/api/v1")
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() { return users; }

    @DeleteMapping("/users/{id}")
    public void deleteUser() {}
}
`);
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(2);
    expect(routes[0]?.path).toBe('/api/v1/users');
    expect(routes[1]?.path).toBe('/api/v1/users/:id');
  });

  it('converts curly brace path params to colon style', () => {
    const file = makeFile('src/OrderController.java', `
@RestController
public class OrderController {
    @GetMapping("/orders/{orderId}/items/{itemId}")
    public Item getItem() { return item; }
}
`);
    const routes = parseSpringRoutes([file]);
    expect(routes[0]?.path).toBe('/orders/:orderId/items/:itemId');
  });

  it('handles RequestMapping with explicit method inside a class', () => {
    const file = makeFile('src/Ctrl.java', `
@RestController
public class PingController {
    @RequestMapping(value = "/ping", method = RequestMethod.GET)
    public String ping() { return "pong"; }
}
`);
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/ping' });
  });

  it('ignores RequestMapping without explicit method', () => {
    const file = makeFile('src/Ctrl.java', `
@RequestMapping("/root")
public class RootController {}
`);
    const routes = parseSpringRoutes([file]);
    expect(routes).toHaveLength(0);
  });

  it('ignores non-java files', () => {
    const file = makeFile('Ctrl.kt', `@GetMapping("/users")\nfun getUsers() {}`);
    expect(parseSpringRoutes([file])).toHaveLength(0);
  });
});
