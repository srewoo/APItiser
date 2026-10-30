/**
 * Reading and editing the user's source for reviewed code fixes. Every path is confined to the
 * repo root; edits are exact, unique find/replace pairs applied all-or-nothing, with the
 * originals backed up first so the user can undo.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BACKUPS = path.join(os.homedir(), '.apitiser', 'backups');

/** `rel` resolved under `root`, or null if it escapes it (../, absolute paths). */
export const insideRoot = (root, rel) => {
  const base = path.resolve(root);
  const full = path.resolve(base, String(rel ?? ''));
  return full.startsWith(base + path.sep) ? full : null;
};

/**
 * Read repo files for the model. Missing/unsafe paths are skipped; each file is capped so the
 * reply stays under Chrome's 1 MB native-messaging frame.
 */
export const readRepoFiles = (root, paths, { maxBytesPerFile = 120_000, maxFiles = 4 } = {}) => {
  const files = [];
  for (const rel of [...new Set(paths)].slice(0, maxFiles)) {
    const full = insideRoot(root, rel);
    if (!full || !existsSync(full) || !statSync(full).isFile()) continue;
    const content = readFileSync(full, 'utf8');
    files.push({ path: rel, content: content.slice(0, maxBytesPerFile), truncated: content.length > maxBytesPerFile });
  }
  return files;
};

const occurrences = (text, needle) => {
  if (!needle) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
};

/**
 * Apply `edits` ([{ path, find, replace }]) under `root`. Validates every edit first — the
 * path must be allowed and `find` must occur exactly once — so a bad edit changes nothing.
 * Returns the backup id for undo.
 */
export const applyEdits = (root, edits, { allowedPaths, backupsDir = DEFAULT_BACKUPS, now = Date.now() } = {}) => {
  if (!Array.isArray(edits) || !edits.length) throw new Error('The fix contains no edits.');
  const allowed = allowedPaths ? new Set(allowedPaths) : null;
  const next = new Map(); // full path → new content, edits to the same file applied in order
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1} (${edit?.path})`;
    if (allowed && !allowed.has(edit?.path)) throw new Error(`${label} targets a file the fix wasn't shown — refusing.`);
    const full = insideRoot(root, edit?.path);
    if (!full || !existsSync(full)) throw new Error(`${label}: file not found inside the repo.`);
    const current = next.get(full) ?? readFileSync(full, 'utf8');
    const count = occurrences(current, edit.find);
    if (count !== 1) {
      throw new Error(`${label}: the text to replace ${count === 0 ? 'no longer matches the file' : `matches ${count} places`} — nothing was changed.`);
    }
    next.set(full, current.replace(edit.find, () => String(edit.replace ?? '')));
  }

  const backupId = `${now}`;
  const backupDir = path.join(backupsDir, backupId);
  const files = [...next.keys()].map((full) => path.relative(root, full));
  for (const rel of files) {
    const target = path.join(backupDir, 'files', rel);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, rel), target);
  }
  writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ root: path.resolve(root), files, createdAt: now }, null, 2));
  for (const [full, content] of next) writeFileSync(full, content);
  return { backupId, files };
};

/** Put the backed-up originals back. */
export const restoreBackup = (backupId, { backupsDir = DEFAULT_BACKUPS } = {}) => {
  const backupDir = insideRoot(backupsDir, String(backupId));
  const manifestPath = backupDir && path.join(backupDir, 'manifest.json');
  if (!manifestPath || !existsSync(manifestPath)) throw new Error('That backup no longer exists — nothing to undo.');
  const { root, files } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const rel of files) {
    const target = insideRoot(root, rel);
    if (target) copyFileSync(path.join(backupDir, 'files', rel), target);
  }
  return { root, files };
};
