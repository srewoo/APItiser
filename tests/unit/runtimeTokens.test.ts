import { describe, expect, it } from 'vitest';
import {
  hasRuntimeToken,
  jsTemplatePath,
  jsPathExpr,
  pyPathExpr,
  goPathExpr,
  javaPathExpr
} from '@background/generation/frameworks/runtimeTokens';

const jsonLit = (literal: string): string => JSON.stringify(literal);

describe('runtimeTokens', () => {
  it('detects {{NAME}} runtime placeholders', () => {
    expect(hasRuntimeToken('/users/{{USER_ID}}')).toBe(true);
    expect(hasRuntimeToken('/users/1')).toBe(false);
    // single-brace route templates are not runtime tokens
    expect(hasRuntimeToken('/users/{id}')).toBe(false);
  });

  it('jsTemplatePath rewrites tokens to env reads and leaves plain paths untouched', () => {
    expect(jsTemplatePath('/users/{{USER_ID}}/posts')).toBe("/users/${process.env.USER_ID || 'replace-me'}/posts");
    expect(jsTemplatePath('/users/1')).toBe('/users/1');
  });

  it('jsPathExpr returns a JSON literal or a template-literal expression', () => {
    expect(jsPathExpr('/users/1')).toBe('"/users/1"');
    expect(jsPathExpr('/users/{{USER_ID}}')).toBe("`/users/${process.env.USER_ID || 'replace-me'}`");
  });

  it('pyPathExpr concatenates os.getenv reads', () => {
    expect(pyPathExpr('/users/1', jsonLit)).toBe('BASE_URL + "/users/1"');
    expect(pyPathExpr('/users/{{USER_ID}}', jsonLit)).toBe('BASE_URL + "/users/" + os.getenv("USER_ID", \'replace-me\')');
  });

  it('goPathExpr concatenates getEnv reads', () => {
    expect(goPathExpr('/users/1', jsonLit)).toBe('"/users/1"');
    expect(goPathExpr('/users/{{USER_ID}}', jsonLit)).toBe('"/users/" + getEnv("USER_ID", "replace-me")');
  });

  it('javaPathExpr concatenates System.getenv reads', () => {
    expect(javaPathExpr('/users/1', jsonLit)).toBe('"/users/1"');
    expect(javaPathExpr('/users/{{USER_ID}}', jsonLit)).toBe('"/users/" + System.getenv().getOrDefault("USER_ID", "replace-me")');
  });
});
