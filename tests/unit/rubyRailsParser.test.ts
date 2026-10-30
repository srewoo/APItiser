import { describe, expect, it } from 'vitest';
import { parseRailsRoutes } from '@background/parser/languages/ruby';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

describe('parseRailsRoutes', () => {
  it('expands resources and prefixes with namespace/scope', () => {
    const file = makeFile(
      'config/routes.rb',
      `Rails.application.routes.draw do
  get '/health', to: 'system#health'

  namespace :api do
    scope '/v1' do
      resources :users
      post 'login', to: 'sessions#create'
    end
  end
end
`
    );

    const endpoints = parseRailsRoutes([file]);
    const paths = endpoints.map((e) => `${e.method} ${e.path}`);

    expect(paths).toContain('GET /health');
    expect(paths).toContain('POST /api/v1/login');
    // resources :users expanded under /api/v1
    expect(paths).toContain('GET /api/v1/users');
    expect(paths).toContain('POST /api/v1/users');
    expect(paths).toContain('GET /api/v1/users/:id');
    expect(paths).toContain('PATCH /api/v1/users/:id');
    expect(paths).toContain('DELETE /api/v1/users/:id');
    expect(endpoints.every((e) => e.source === 'rails')).toBe(true);
  });

  it('handles member and collection blocks and nested resources', () => {
    const file = makeFile(
      'config/routes.rb',
      `Rails.application.routes.draw do
  resources :posts do
    member do
      post 'publish'
    end
    collection do
      get 'search'
    end
    resources :comments
  end
end
`
    );

    const paths = parseRailsRoutes([file]).map((e) => `${e.method} ${e.path}`);
    // member → /posts/:id/publish ; collection → /posts/search
    expect(paths).toContain('POST /posts/:id/publish');
    expect(paths).toContain('GET /posts/search');
    // nested resources → /posts/:post_id/comments
    expect(paths).toContain('GET /posts/:post_id/comments');
    expect(paths).toContain('POST /posts/:post_id/comments');
    expect(paths).toContain('DELETE /posts/:post_id/comments/:id');
  });

  it('ignores non-Rails ruby files', () => {
    expect(parseRailsRoutes([makeFile('lib/util.rb', 'def foo; end')])).toHaveLength(0);
  });
});
