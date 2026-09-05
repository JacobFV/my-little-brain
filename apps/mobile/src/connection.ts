export function normalizeServerUrl(value: string, development: boolean): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Enter a server URL without credentials, query parameters, or a fragment.');
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:'))
    throw new Error('Use an HTTPS server URL. HTTP is available only during development.');
  if (url.pathname !== '/') throw new Error('Enter the server origin, without a path.');
  return url.origin;
}

export function inferDevelopmentUrl(hostUri?: string | null): string {
  if (!hostUri) return 'http://localhost:5173';
  try {
    return `http://${new URL(`http://${hostUri}`).hostname}:5173`;
  } catch {
    return 'http://localhost:5173';
  }
}
