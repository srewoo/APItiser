// Type declarations for the native host's stack-planning helpers (used by unit tests).
export function hasStackMarker(dir: string): boolean;
export function normalizeRemote(url: string): string;
export function readOriginUrl(dir: string): string;
export function findLocalClone(slug: string, options?: { roots?: string[]; maxDepth?: number; maxDirs?: number }): string | null;
export function managedClonePath(slug: string, base?: string): string;
export function cloneOrUpdate(
  cloneUrl: string,
  dest: string,
  options?: { token?: string; platform?: string }
): Promise<{ updated: boolean; error?: string }>;
export function pickApiDir(root: string, hint?: string): string;
export function pickFrontendDir(root: string, apiDir: string): string | null;
export function frontendEnv(backendUrl: string): Record<string, string>;
export function ensureEnvFile(appDir: string, root: string): string | null;
export function findComposeFile(dir: string): string | null;
export interface ComposeService {
  name: string;
  image: string;
  ports: number[];
}
export function parseComposeServices(text: string): ComposeService[];
export function infraServices(services: ComposeService[]): ComposeService[];
export function expandHome(p: string | undefined): string;
export function searchRootsFor(options?: { cloneRoot?: string; extraRoots?: string[] }, home?: string): string[];
export function cloneDestination(slug: string, cloneRoot?: string, cloneUrl?: string): { dest: string; managed: boolean };
export function folderPickerCommand(platform?: string, prompt?: string): { cmd: string; args: string[] };
