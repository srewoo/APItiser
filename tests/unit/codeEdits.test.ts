import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEdits, insideRoot, readRepoFiles, restoreBackup } from '../../native-host/codeEdits.mjs';

let root: string;
let backupsDir: string;
const write = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
};
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'apitiser-edits-'));
  root = path.join(base, 'repo');
  backupsDir = path.join(base, 'backups');
  mkdirSync(root);
  write('api/users.py', 'def get_user(id):\n    return db[id]  # KeyError -> 500\n');
  write('api/orders.py', 'x = 1\nx = 1\n');
});
afterEach(() => rmSync(path.dirname(root), { recursive: true, force: true }));

describe('insideRoot / readRepoFiles', () => {
  it('rejects paths that escape the repo', () => {
    expect(insideRoot(root, '../secrets')).toBeNull();
    expect(insideRoot(root, '/etc/passwd')).toBeNull();
    expect(insideRoot(root, 'api/users.py')).toBe(path.join(root, 'api/users.py'));
  });

  it('reads only existing files inside the repo', () => {
    const files = readRepoFiles(root, ['api/users.py', '../escape.txt', 'missing.py']);
    expect(files.map((file) => file.path)).toEqual(['api/users.py']);
  });
});

describe('applyEdits / restoreBackup', () => {
  const fix = { path: 'api/users.py', find: '    return db[id]  # KeyError -> 500', replace: '    if id not in db:\n        raise HTTPException(404)\n    return db[id]' };

  it('applies, backs up the original, and undo restores it', () => {
    const { backupId, files } = applyEdits(root, [fix], { allowedPaths: ['api/users.py'], backupsDir });
    expect(files).toEqual(['api/users.py']);
    expect(read('api/users.py')).toContain('raise HTTPException(404)');
    restoreBackup(backupId, { backupsDir });
    expect(read('api/users.py')).toContain('KeyError -> 500');
  });

  it('changes nothing when any edit does not match exactly once', () => {
    const before = read('api/users.py');
    expect(() =>
      applyEdits(root, [fix, { path: 'api/orders.py', find: 'x = 1', replace: 'x = 2' }], { allowedPaths: ['api/users.py', 'api/orders.py'], backupsDir })
    ).toThrow(/matches 2 places — nothing was changed/);
    expect(read('api/users.py')).toBe(before);
    expect(existsSync(backupsDir)).toBe(false);
    expect(() => applyEdits(root, [{ ...fix, find: 'not in the file' }], { backupsDir })).toThrow(/no longer matches/);
  });

  it('refuses files the fix was not shown, and paths outside the repo', () => {
    expect(() => applyEdits(root, [{ path: 'api/orders.py', find: 'x', replace: 'y' }], { allowedPaths: ['api/users.py'], backupsDir })).toThrow(/wasn't shown/);
    expect(() => applyEdits(root, [{ path: '../evil.py', find: 'x', replace: 'y' }], { backupsDir })).toThrow(/not found inside the repo/);
  });

  it('applies several edits to one file in order', () => {
    write('a.js', 'one\ntwo\n');
    applyEdits(root, [{ path: 'a.js', find: 'one', replace: 'ONE' }, { path: 'a.js', find: 'two', replace: 'TWO' }], { backupsDir });
    expect(read('a.js')).toBe('ONE\nTWO\n');
  });

  it('reports a missing backup clearly', () => {
    expect(() => restoreBackup('nope', { backupsDir })).toThrow(/no longer exists/);
  });
});
