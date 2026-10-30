// Type declarations for the native host's code-edit helpers (used by unit tests).
export function insideRoot(root: string, rel: string): string | null;
export function readRepoFiles(
  root: string,
  paths: string[],
  options?: { maxBytesPerFile?: number; maxFiles?: number }
): Array<{ path: string; content: string; truncated: boolean }>;
export interface CodeEdit {
  path: string;
  find: string;
  replace: string;
}
export function applyEdits(
  root: string,
  edits: CodeEdit[],
  options?: { allowedPaths?: string[]; backupsDir?: string; now?: number }
): { backupId: string; files: string[] };
export function restoreBackup(backupId: string, options?: { backupsDir?: string }): { root: string; files: string[] };
