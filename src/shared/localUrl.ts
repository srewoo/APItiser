/**
 * True when `url` points at the developer's own machine (loopback). Live tests fire mutating
 * and attack-style requests, so anything else needs an explicit opt-in.
 */
export const isLoopbackUrl = (url: string): boolean => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
};
