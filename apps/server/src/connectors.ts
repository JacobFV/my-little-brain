/** Read-only provider adapters shared by Express and Cloudflare. No credential persistence. */
export type AccountProvider = 'notion' | 'google' | 'github';
export type AccountItem = { id: string; title: string; url?: string; text?: string };
export type AccountResult = { label?: string; items: AccountItem[]; truncated?: boolean };
export type ConnectorEnv = {
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  NOTION_REDIRECT_URI?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};
export class ConnectorError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const invalid = () => new ConnectorError(400, 'Invalid account request.');
const string = (v: unknown, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : '');
const rich = (v: any) =>
  Array.isArray(v) ? v.map((t: any) => string(t.plain_text || t.text?.content)).join('') : '';
function safeUrl(value: unknown) {
  try {
    const u = new URL(string(value, 2048));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}
function credential(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 8192 ||
    /[^\x21-\x7e]/.test(value)
  )
    throw invalid();
  return value;
}
async function limitedText(response: Response, max = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0,
    text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        throw new ConnectorError(413, 'This file is too large to read. Choose a smaller document.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
async function upstream(
  requestFetch: typeof fetch,
  url: string,
  init: RequestInit = {},
  asText = false,
): Promise<any> {
  try {
    const response = await requestFetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      throw new ConnectorError(
        status === 401 || status === 403 || status === 404 || status === 429 ? status : 502,
        status === 401
          ? 'This account credential expired or is invalid. Reconnect the account.'
          : status === 403
            ? 'The account does not grant access. Check token permissions and shared content.'
            : status === 404
              ? 'Content was not found or is not shared with this connection.'
              : status === 429
                ? 'The provider is rate limiting requests. Try again shortly.'
                : 'The provider request failed. Try again.',
      );
    }
    const content = await limitedText(response);
    return asText ? content : JSON.parse(content);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError(
      502,
      'Could not reach the account provider. Check the network and try again.',
    );
  }
}
export async function runConnector(
  input: any,
  requestFetch: typeof fetch = fetch,
): Promise<AccountResult> {
  if (
    !input ||
    !['notion', 'google', 'github'].includes(input.provider) ||
    !['verify', 'search', 'read'].includes(input.operation)
  )
    throw invalid();
  const token = credential(input.credential),
    provider = input.provider as AccountProvider;
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200))
    throw invalid();
  const query = input.query || '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (provider === 'notion') headers['Notion-Version'] = '2025-09-03';
  if (provider === 'github') {
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    headers['User-Agent'] = 'My-Little-Brain';
  }
  const get = (url: string, text = false) => upstream(requestFetch, url, { headers }, text);
  if (input.operation === 'verify') {
    const value = await get(
      provider === 'notion'
        ? 'https://api.notion.com/v1/users/me'
        : provider === 'google'
          ? 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)'
          : 'https://api.github.com/user',
    );
    const label =
      provider === 'notion'
        ? value.bot?.workspace_name || value.name
        : provider === 'google'
          ? value.user?.displayName || value.user?.emailAddress
          : value.login;
    if (!label || (provider !== 'google' && !value.id))
      throw new ConnectorError(502, 'Provider returned an invalid account identity.');
    return { label: string(label, 200), items: [] };
  }
  if (input.operation === 'search') {
    if (provider === 'notion') {
      const data = await upstream(requestFetch, 'https://api.notion.com/v1/search', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          page_size: 20,
          filter: { property: 'object', value: 'page' },
        }),
      });
      return {
        items: (data.results || []).slice(0, 20).map((p: any) => ({
          id: string(p.id),
          title:
            rich(
              Object.values(p.properties || {}).find((v: any) => v.type === 'title') &&
                (Object.values(p.properties || {}).find((v: any) => v.type === 'title') as any)
                  .title,
            ) || 'Untitled page',
          url: safeUrl(p.url),
        })),
        truncated: Boolean(data.has_more),
      };
    }
    if (provider === 'google') {
      const q =
        'trashed = false' +
        (query
          ? ` and fullText contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
          : '');
      const params = new URLSearchParams({
        q,
        pageSize: '20',
        fields: 'nextPageToken,files(id,name,webViewLink,mimeType)',
        orderBy: 'modifiedTime desc',
      });
      const data = await get('https://www.googleapis.com/drive/v3/files?' + params);
      return {
        items: (data.files || []).slice(0, 20).map((p: any) => ({
          id: string(p.id),
          title: string(p.name),
          url: safeUrl(p.webViewLink),
        })),
        truncated: Boolean(data.nextPageToken),
      };
    }
    // Search only repositories accessible to this account, including private repos.
    const data = await get('https://api.github.com/user/repos?per_page=100&sort=updated');
    if (!Array.isArray(data))
      throw new ConnectorError(502, 'Provider returned invalid repositories.');
    const matches = data.filter((p: any) =>
      `${p.full_name} ${p.description || ''}`.toLowerCase().includes(query.toLowerCase()),
    );
    return {
      items: matches.slice(0, 20).map((p: any) => ({
        id: string(p.full_name),
        title: string(p.full_name),
        url: safeUrl(p.html_url),
        text: string(p.description),
      })),
      truncated: data.length === 100 || matches.length > 20,
    };
  }
  const id = input.id;
  if (typeof id !== 'string') throw invalid();
  if (provider === 'notion') {
    if (
      !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id)
    )
      throw invalid();
    const data = await get(`https://api.notion.com/v1/blocks/${id}/children?page_size=100`);
    const blocks = (data.results || []).slice(0, 100);
    const text = blocks
      .map(
        (b: any) =>
          rich(b[b.type]?.rich_text) ||
          string(b[b.type]?.caption && rich(b[b.type].caption)) ||
          string(b[b.type]?.title),
      )
      .filter(Boolean)
      .join('\n');
    return {
      items: [
        {
          id,
          title: 'Notion page content',
          url: 'https://www.notion.so/' + id.replaceAll('-', ''),
          text: text.slice(0, 24000),
        },
      ],
      truncated:
        Boolean(data.has_more) || blocks.some((b: any) => b.has_children) || text.length > 24000,
    };
  }
  if (provider === 'google') {
    if (!/^[\w-]{1,200}$/.test(id)) throw invalid();
    const base = 'https://www.googleapis.com/drive/v3/files/' + id;
    const meta = await get(base + '?fields=id,name,mimeType,webViewLink,size');
    const exports: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    };
    const exportType = exports[meta.mimeType];
    if (
      !exportType &&
      !(
        String(meta.mimeType).startsWith('text/') ||
        ['application/json', 'application/xml'].includes(meta.mimeType)
      )
    )
      throw new ConnectorError(
        415,
        'Read supports Google Docs, Sheets (first sheet), Slides, and text files. Open other formats in Drive.',
      );
    if (Number(meta.size) > 1024 * 1024)
      throw new ConnectorError(413, 'This file is too large to read. Choose a smaller document.');
    const text: string = await get(
      base + (exportType ? '/export?mimeType=' + encodeURIComponent(exportType) : '?alt=media'),
      true,
    );
    return {
      items: [
        {
          id,
          title: string(meta.name),
          url: safeUrl(meta.webViewLink),
          text: text.slice(0, 24000),
        },
      ],
      truncated: text.length > 24000 || meta.mimeType === 'application/vnd.google-apps.spreadsheet',
    };
  }
  if (
    !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(id) ||
    id.split('/').some((s: string) => s === '.' || s === '..')
  )
    throw invalid();
  const text = await upstream(
    requestFetch,
    `https://api.github.com/repos/${id}/readme`,
    { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } },
    true,
  );
  return {
    items: [
      { id, title: id + ' README', url: 'https://github.com/' + id, text: text.slice(0, 24000) },
    ],
    truncated: text.length > 24000,
  };
}
export function oauthConfig(env: ConnectorEnv) {
  const config = (provider: 'GOOGLE' | 'NOTION') => {
    try {
      const uri = new URL(env[`${provider}_REDIRECT_URI`] || '');
      const clientId = env[`${provider}_CLIENT_ID`];
      if (
        !clientId ||
        !env[`${provider}_CLIENT_SECRET`] ||
        uri.username ||
        uri.password ||
        uri.hash ||
        uri.searchParams.get('account_oauth') !== provider.toLowerCase() ||
        (uri.protocol !== 'https:' &&
          !(uri.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(uri.hostname)))
      )
        return null;
      return { clientId, redirectUri: uri.href };
    } catch {
      return null;
    }
  };
  return { google: config('GOOGLE'), notion: config('NOTION') };
}
export async function exchangeNotion(
  input: any,
  env: ConnectorEnv,
  requestFetch: typeof fetch = fetch,
) {
  const config = oauthConfig(env).notion;
  if (!config)
    throw new ConnectorError(
      503,
      'Notion sign-in is not configured. Use an integration token or configure server OAuth settings.',
    );
  if (!input || typeof input.code !== 'string' || !input.code || input.code.length > 4096)
    throw invalid();
  const data = await upstream(requestFetch, 'https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(`${config.clientId}:${env.NOTION_CLIENT_SECRET}`),
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: config.redirectUri,
    }),
  });
  return { credential: credential(data.access_token) };
}
export async function exchangeGoogle(
  input: any,
  env: ConnectorEnv,
  requestFetch: typeof fetch = fetch,
) {
  const config = oauthConfig(env).google;
  if (!config)
    throw new ConnectorError(
      503,
      'Google sign-in is not configured. Use an access token or configure the server OAuth settings.',
    );
  if (
    !input ||
    typeof input.code !== 'string' ||
    input.code.length > 4096 ||
    !input.code ||
    typeof input.verifier !== 'string' ||
    !/^[\w.~\-]{43,128}$/.test(input.verifier)
  )
    throw invalid();
  const data = await upstream(requestFetch, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: config.redirectUri,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: 'authorization_code',
    }),
  });
  return { credential: credential(data.access_token) }; // Refresh tokens are intentionally discarded.
}
