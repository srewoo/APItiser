import type { GeneratedArtifact, GeneratedFile, ReadinessState, TestFramework, ValidationSummary } from '@shared/types';
import { createId } from '@background/utils/id';
import JSZip from 'jszip';

export const buildArtifactZip = async (
  framework: TestFramework,
  files: GeneratedFile[],
  options?: {
    readiness?: ReadinessState;
    readinessNotes?: string[];
    validationSummary?: ValidationSummary;
  }
): Promise<GeneratedArtifact> => {
  const zip = new JSZip();

  for (const file of files) {
    zip.file(file.path, file.content);
  }

  const zipBase64 = await zip.generateAsync({ type: 'base64' });

  return {
    id: createId('artifact'),
    createdAt: Date.now(),
    fileName: options?.readiness ? `api-tests-${options.readiness}.zip` : 'api-tests.zip',
    framework,
    files,
    zipBase64,
    readiness: options?.readiness,
    readinessNotes: options?.readinessNotes,
    validationSummary: options?.validationSummary
  };
};
