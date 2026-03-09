import type { RepoFile } from '@shared/types';

interface FallbackResult {
  files: RepoFile[];
  usedFallback: boolean;
  fallbackPath?: string;
}

const detectExtension = (spec: string): 'json' | 'yaml' => {
  const trimmed = spec.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  return 'yaml';
};

export const applyOpenApiFallback = (files: RepoFile[], openApiFallbackSpec?: string): FallbackResult => {
  const spec = openApiFallbackSpec?.trim() ?? '';
  if (!spec) {
    return { files, usedFallback: false };
  }

  const extension = detectExtension(spec);
  const fallbackPath = `openapi.manual.${extension}`;
  const existingIndex = files.findIndex((file) => file.path === fallbackPath);

  if (existingIndex > -1) {
    const updated = [...files];
    updated[existingIndex] = {
      ...updated[existingIndex],
      content: spec,
      size: spec.length
    };
    return { files: updated, usedFallback: true, fallbackPath };
  }

  return {
    files: [
      ...files,
      {
        path: fallbackPath,
        content: spec,
        size: spec.length
      }
    ],
    usedFallback: true,
    fallbackPath
  };
};
