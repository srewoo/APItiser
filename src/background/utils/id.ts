export const createId = (prefix: string): string => {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now()}_${random[0].toString(16)}${random[1].toString(16)}`;
};
