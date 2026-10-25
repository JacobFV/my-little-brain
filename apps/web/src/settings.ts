export type Settings = {
  showThoughts: boolean;
  reducedMotion: boolean;
  endpoint: string;
  token: string;
  chatWidth: number;
};
type ReadStorage = { getItem: (key: string) => string | null };
function read(storage: ReadStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
function endpoint(value: unknown, fallback: string) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.origin
      : fallback;
  } catch {
    return fallback;
  }
}
export function loadSettings(
  local: ReadStorage,
  session: ReadStorage,
  reducedMotion: boolean,
  defaultEndpoint: string,
): Settings {
  let saved: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(read(local, 'little-brain.settings') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch {}
  return {
    showThoughts: saved.showThoughts === true,
    reducedMotion: typeof saved.reducedMotion === 'boolean' ? saved.reducedMotion : reducedMotion,
    endpoint: endpoint(saved.endpoint, endpoint(defaultEndpoint, '')),
    token: read(session, 'little-brain.token') || '',
    chatWidth:
      typeof saved.chatWidth === 'number' && Number.isFinite(saved.chatWidth)
        ? Math.min(560, Math.max(300, saved.chatWidth))
        : 360,
  };
}
