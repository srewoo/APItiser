/**
 * Build the downloadable local-runner zip from the files embedded at build time. This lets
 * the extension serve the native host + installer + runLocal directly to the user — no
 * external download host, consistent with the "no backend" constraint.
 */
import JSZip from 'jszip';
import { RUNNER_FILES, RUNNER_VERSION } from '@shared/generated/runnerBundle';

export const runnerZipFileName = (): string => `apitiser-local-runner-v${RUNNER_VERSION}.zip`;

/**
 * Returns the runner package as base64 (for a data: download URL). Scripts and the host are
 * marked executable (unix 0o755) so `./install.sh` works straight after unzip on macOS/Linux.
 */
export const buildRunnerZipBase64 = async (): Promise<string> => {
  const zip = new JSZip();
  for (const file of RUNNER_FILES) {
    zip.file(file.path, file.content, file.exec ? { unixPermissions: 0o755 } : { unixPermissions: 0o644 });
  }
  return zip.generateAsync({ type: 'base64', platform: 'UNIX' });
};
