import JSZip from 'jszip';
import type { GeneratedArtifact, GeneratedFile, TestFramework } from '@shared/types';
import { createId } from '@background/utils/id';

export const buildArtifactZip = async (
  framework: TestFramework,
  files: GeneratedFile[]
): Promise<GeneratedArtifact> => {
  const zip = new JSZip();

  for (const file of files) {
    zip.file(file.path, file.content);
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64' });

  return {
    id: createId('artifact'),
    createdAt: Date.now(),
    fileName: 'api-tests.zip',
    framework,
    files,
    zipBase64
  };
};
