import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  cloneDestination,
  expandHome,
  folderPickerCommand,
  searchRootsFor,
  cloneOrUpdate,
  ensureEnvFile,
  findLocalClone,
  infraServices,
  normalizeRemote,
  parseComposeServices,
  pickApiDir,
  pickFrontendDir
} from '../../native-host/stack.mjs';

let root: string;
const write = (rel: string, content = '') => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const fakeClone = (rel: string, url: string) =>
  write(`${rel}/.git/config`, `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'apitiser-stack-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('normalizeRemote', () => {
  it.each([
    ['https://github.com/srewoo/FortKnoxx.git', 'github.com/srewoo/fortknoxx'],
    ['git@github.com:srewoo/FortKnoxx.git', 'github.com/srewoo/fortknoxx'],
    ['ssh://git@gitlab.acme.io:2222/grp/sub/api.git', 'gitlab.acme.io/grp/sub/api'],
    ['https://user:token@github.com/a/b/', 'github.com/a/b'],
    ['not a url', '']
  ])('%s → %s', (url, slug) => {
    expect(normalizeRemote(url)).toBe(slug);
  });
});

describe('findLocalClone', () => {
  it('finds the clone whose origin matches, whatever the folder is called', () => {
    fakeClone('code/other-project', 'https://github.com/acme/other.git');
    fakeClone('code/my-copy', 'git@github.com:Acme/API.git');
    expect(findLocalClone('github.com/acme/api', { roots: [root] })).toBe(path.join(root, 'code/my-copy'));
  });

  it('skips dependency folders and gives up beyond the depth limit', () => {
    fakeClone('node_modules/api', 'https://github.com/acme/api.git');
    fakeClone('a/b/c/d/api', 'https://github.com/acme/api.git');
    expect(findLocalClone('github.com/acme/api', { roots: [root], maxDepth: 3 })).toBeNull();
  });
});

// These spawn real git processes (clone/fetch); give them room on a busy machine.
describe('cloneOrUpdate', { timeout: 60_000 }, () => {
  it('clones, then refreshes, and never writes the token into .git/config', async () => {
    const origin = path.join(root, 'origin');
    mkdirSync(origin);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');

    const dest = path.join(root, 'managed', 'repo');
    await cloneOrUpdate(`file://${origin}`, dest, { token: 'secret-token', platform: 'github' });
    expect(existsSync(path.join(dest, '.git'))).toBe(true);
    expect(readFileSync(path.join(dest, '.git', 'config'), 'utf8')).not.toContain('secret-token');

    const again = await cloneOrUpdate(`file://${origin}`, dest, {});
    expect(again.updated).toBe(true);
  });

  it('explains a failed clone, hinting at a token for private repos', async () => {
    await expect(cloneOrUpdate(`file://${path.join(root, 'missing')}`, path.join(root, 'x'))).rejects.toThrow(/private repo\? add a GitHub\/GitLab token/);
  });
});

describe('stack planning', () => {
  beforeEach(() => {
    write('docker-compose.yml', [
      'services:',
      '  mongo:',
      '    image: mongo:7',
      '    ports:',
      '      - "27017:27017"',
      '  redis:',
      '    image: redis:7-alpine # cache',
      '    ports:',
      "      - '6379:6379'",
      '  backend:',
      '    build: ./backend',
      '    ports:',
      '      - "8000:8000"',
      'volumes:',
      '  mongo_data:'
    ].join('\n'));
    write('backend/requirements.txt', 'fastapi\n');
    write('backend/api/routes.py');
    write('frontend/package.json', JSON.stringify({ dependencies: { react: '^18' } }));
    write('tools/package.json', JSON.stringify({ dependencies: { lodash: '^4' } }));
  });

  it('picks the API folder from the route hint, walking up to the nearest stack marker', () => {
    expect(pickApiDir(root, 'backend/api')).toBe(path.join(root, 'backend'));
  });

  it('falls back to a conventional backend folder when the root is compose-only', () => {
    expect(pickApiDir(root)).toBe(path.join(root, 'backend'));
  });

  it('finds the web frontend, not other Node packages', () => {
    expect(pickFrontendDir(root, path.join(root, 'backend'))).toBe(path.join(root, 'frontend'));
  });

  it('reads compose services and keeps only infrastructure', () => {
    const services = parseComposeServices(readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
    expect(services.map((s) => `${s.name}:${s.ports.join(',')}`)).toEqual(['mongo:27017', 'redis:6379', 'backend:8000']);
    expect(infraServices(services).map((s) => s.name)).toEqual(['mongo', 'redis']);
  });

  it('creates .env from a sample once, never overwriting', () => {
    write('env.sample', 'JWT_SECRET_KEY=change-me\n');
    const backend = path.join(root, 'backend');
    expect(ensureEnvFile(backend, root)).toBe(path.join(root, 'env.sample'));
    expect(readFileSync(path.join(backend, '.env'), 'utf8')).toContain('JWT_SECRET_KEY');
    writeFileSync(path.join(backend, '.env'), 'MINE=1');
    expect(ensureEnvFile(backend, root)).toBeNull();
    expect(readFileSync(path.join(backend, '.env'), 'utf8')).toBe('MINE=1');
  });
});

describe('user-chosen locations', () => {
  it('expands ~ and leaves other paths alone', () => {
    expect(expandHome('~/code')).toBe(path.join(homedir(), 'code'));
    expect(expandHome('/abs/x')).toBe('/abs/x');
    expect(expandHome(undefined as unknown as string)).toBe('');
  });

  it('searches the clone folder and extra folders before home, skipping missing ones', () => {
    mkdirSync(path.join(root, 'clones'));
    mkdirSync(path.join(root, 'docs-github'));
    const roots = searchRootsFor({ cloneRoot: path.join(root, 'clones'), extraRoots: [path.join(root, 'docs-github'), path.join(root, 'nope')] }, root);
    expect(roots).toEqual([path.join(root, 'clones'), path.join(root, 'docs-github'), root]);
  });

  it('finds a clone inside an extra folder even when its name is normally skipped', () => {
    fakeClone('Documents/GitHub/api', 'https://github.com/acme/api.git');
    expect(findLocalClone('github.com/acme/api', { roots: [root] })).toBeNull(); // Documents skipped by default
    expect(findLocalClone('github.com/acme/api', { roots: [path.join(root, 'Documents')] })).toBe(path.join(root, 'Documents/GitHub/api'));
  });

  it('clones into <root>/<repo>, or <root>/<owner>-<repo> when that name is taken', () => {
    expect(cloneDestination('github.com/acme/api', root)).toEqual({ dest: path.join(root, 'api'), managed: false });
    mkdirSync(path.join(root, 'api'));
    expect(cloneDestination('github.com/acme/api', root).dest).toBe(path.join(root, 'acme-api'));
    expect(cloneDestination('github.com/acme/api', '').managed).toBe(true);
    // Real name, case preserved, from the clone URL.
    expect(cloneDestination('github.com/octocat/hello-world', root, 'https://github.com/octocat/Hello-World.git').dest).toBe(path.join(root, 'Hello-World'));
  });

  it('uses the native folder dialog for each OS', () => {
    expect(folderPickerCommand('darwin').cmd).toBe('osascript');
    expect(folderPickerCommand('darwin', 'Pick "it"').args.join(' ')).toContain('choose folder with prompt "Pick it"');
    expect(folderPickerCommand('win32').cmd).toBe('powershell');
    expect(folderPickerCommand('linux').cmd).toBe('zenity');
  });
});
