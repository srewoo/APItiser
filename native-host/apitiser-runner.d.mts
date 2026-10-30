// Type declarations for the exported pure helpers of the native-messaging host script.
// The runtime file (apitiser-runner.mjs) is plain Node ESM; these types let tests import it.

export function isValidPort(value: unknown): boolean;
export function isPathInsideDir(root: string, dest: string): boolean;
export function decodeFrames(
  buffer: Buffer,
  maxBytes?: number
): { messages: unknown[]; rest: Buffer; error?: 'oversized' | 'malformed' };
export function portFromLogLine(line: string): number | undefined;
export function isPortOpen(port: number): Promise<boolean>;
export function findFreePort(): Promise<number>;
