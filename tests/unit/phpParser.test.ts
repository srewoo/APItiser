import { describe, expect, it } from 'vitest';
import { parsePhpEndpoints } from '@background/parser/languages/php';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

describe('parsePhpEndpoints — Laravel', () => {
  it('detects verbs, apiResource expansion, and prefix groups', () => {
    const file = makeFile(
      'routes/api.php',
      `<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/status', [HealthController::class, 'status']);

Route::prefix('api')->group(function () {
    Route::post('/login', [AuthController::class, 'login']);
    Route::apiResource('posts', PostController::class);
});
`
    );

    const paths = parsePhpEndpoints([file]).map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /status');
    expect(paths).toContain('POST /api/login');
    // apiResource posts under /api
    expect(paths).toContain('GET /api/posts');
    expect(paths).toContain('POST /api/posts');
    expect(paths).toContain('GET /api/posts/:post');
    expect(paths).toContain('PUT /api/posts/:post');
    expect(paths).toContain('DELETE /api/posts/:post');
    expect(parsePhpEndpoints([file]).every((e) => e.source === 'laravel')).toBe(true);
  });

  it('handles Route::group array prefix form', () => {
    const file = makeFile(
      'routes/web.php',
      `<?php
Route::group(['prefix' => 'admin', 'middleware' => 'auth'], function () {
    Route::delete('/users/{id}', [AdminController::class, 'destroy']);
});
`
    );
    const paths = parsePhpEndpoints([file]).map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('DELETE /admin/users/:id');
  });
});

describe('parsePhpEndpoints — Symfony', () => {
  it('detects PHP 8 attributes with a class-level prefix and method list', () => {
    const file = makeFile(
      'src/Controller/ApiController.php',
      `<?php
namespace App\\Controller;

use Symfony\\Component\\Routing\\Annotation\\Route;

#[Route('/api')]
class ApiController
{
    #[Route('/orders', methods: ['GET'])]
    public function list(): Response {}

    #[Route('/orders/{id}', methods: ['GET', 'DELETE'])]
    public function show(int $id): Response {}
}
`
    );

    const endpoints = parsePhpEndpoints([file]);
    const paths = endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(paths).toEqual(['DELETE /api/orders/:id', 'GET /api/orders', 'GET /api/orders/:id']);
    expect(endpoints.every((e) => e.source === 'symfony')).toBe(true);
  });

  it('detects legacy @Route annotations', () => {
    const file = makeFile(
      'src/Controller/LegacyController.php',
      `<?php
class LegacyController
{
    /**
     * @Route("/ping", methods={"GET"})
     */
    public function ping() {}
}
`
    );
    const paths = parsePhpEndpoints([file]).map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /ping');
  });

  it('ignores non-php files', () => {
    expect(parsePhpEndpoints([makeFile('app.ts', 'const x = 1;')])).toHaveLength(0);
  });
});
