const cleanSegment = (value: string): string =>
  value
    .replace(/^\/+|\/+$/g, '')
    .replace(/[{}:]/g, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .toLowerCase();

const isParamSegment = (value: string): boolean => value.startsWith(':') || (value.startsWith('{') && value.endsWith('}'));

export const getResourcePath = (path: string): { resource: string; leaf: string; fileBase: string } => {
  const rawSegments = path.split('/').map((segment) => segment.trim()).filter(Boolean);
  const stableSegments = rawSegments.filter((segment) => !isParamSegment(segment)).map(cleanSegment).filter(Boolean);

  const resource = stableSegments[0] ?? 'root';
  const leaf = stableSegments[stableSegments.length - 1] ?? resource;
  return {
    resource,
    leaf,
    fileBase: `${resource}-${leaf}`
  };
};
