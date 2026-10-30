import { describe, expect, it } from 'vitest';
import { maskComments } from '@background/parser/languages/maskComments';
import { parsePythonRoutes } from '@background/parser/languages/python';
import { parseSpringRoutes } from '@background/parser/languages/java';
import { parseGoRoutes } from '@background/parser/languages/go';
import { parseRailsRoutes } from '@background/parser/languages/ruby';
import type { RepoFile } from '@shared/types';

const file = (path: string, content: string): RepoFile => ({ path, content, size: content.length });
const routes = (list: Array<{ method: string; path: string }>) => list.map((r) => `${r.method} ${r.path}`).sort();

describe('maskComments', () => {
  it('keeps length and line breaks so evidence line numbers stay right', () => {
    const src = 'a = 1  # note\n"""doc\nmore"""\nb = 2\n';
    const masked = maskComments(src, 'python');
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n').length).toBe(src.split('\n').length);
    expect(masked).toContain('a = 1');
    expect(masked).toContain('b = 2');
    expect(masked).not.toContain('note');
    expect(masked).not.toContain('doc');
  });

  it('never treats comment markers inside strings as comments', () => {
    expect(maskComments('url = "http://x/#frag"  # real comment', 'python')).toBe('url = "http://x/#frag"                ');
    expect(maskComments('s := "a // b" // c', 'c')).toBe('s := "a // b"     ');
    expect(maskComments('get "/a#b" # c', 'ruby')).toBe('get "/a#b"    ');
  });
});

describe('route detectors ignore documented examples', () => {
  it('Python: a decorator shown in a docstring is not a route; real ones still are', () => {
    const src = [
      'from fastapi import FastAPI',
      'app = FastAPI()',
      'def require_role(roles):',
      '    """Dependency.',
      '    Usage: @app.get("/admin", dependencies=[Depends(require_role([UserRole.ADMIN]))])',
      '    """',
      '# @app.post("/old")',
      '@app.get("/health")',
      'def health():',
      '    return {}'
    ].join('\n');
    expect(routes(parsePythonRoutes([file('backend/auth/rbac.py', src)]))).toEqual(['GET /health']);
  });

  it('Java: a mapping in Javadoc is not a route', () => {
    const src = [
      '@RestController',
      'public class Users {',
      '  /** Example: @GetMapping("/example") */',
      '  // @PostMapping("/old")',
      '  @GetMapping("/users")',
      '  public List<User> list() { return null; }',
      '}'
    ].join('\n');
    expect(routes(parseSpringRoutes([file('src/Users.java', src)]))).toEqual(['GET /users']);
  });

  it('Go: commented-out registrations are not routes', () => {
    const src = ['package main', 'func main() {', '  r := gin.Default()', '  // r.GET("/old", h)', '  r.GET("/users", h)', '}'].join('\n');
    expect(routes(parseGoRoutes([file('main.go', src)]))).toEqual(['GET /users']);
  });

  it('Ruby: commented-out routes are not routes', () => {
    const src = ['Rails.application.routes.draw do', "  # get '/old', to: 'x#y'", "  get '/users', to: 'users#index'", 'end'].join('\n');
    expect(routes(parseRailsRoutes([file('config/routes.rb', src)]))).toEqual(['GET /users']);
  });
});
