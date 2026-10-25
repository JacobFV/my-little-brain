import { describe, expect, it, vi } from 'vitest';
import { runConnector, exchangeGoogle, exchangeNotion, oauthConfig } from './connectors';
const token = 'account-secret-token';
const reply = (data: unknown) => new Response(JSON.stringify(data));
describe('read-only account adapters', () => {
  it('rejects arbitrary providers, write operations, injection and malformed credentials before fetching', async () => {
    const fetcher = vi.fn();
    for (const input of [
      { provider: 'https://evil.test', operation: 'search', credential: token },
      { provider: 'github', operation: 'delete', credential: token },
      { provider: 'github', operation: 'read', id: '../user', credential: token },
      { provider: 'google', operation: 'read', id: 'x?alt=media', credential: token },
      { provider: 'notion', operation: 'verify', credential: token + '\r\nInjected: value' },
    ])
      await expect(runConnector(input, fetcher)).rejects.toThrow('Invalid account request');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('verifies identity, forwards credential privately and rejects redirects', async () => {
    const fetcher = vi.fn(async () => reply({ id: 1, login: 'octocat' }));
    const result = await runConnector(
      { provider: 'github', operation: 'verify', credential: token },
      fetcher,
    );
    expect(result).toEqual({ label: 'octocat', items: [] });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetcher.mock.calls[0]).toEqual([
      'https://api.github.com/user',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer ' + token }),
      }),
    ]);
  });
  it('does not return provider error bodies that might echo credentials', async () => {
    await expect(
      runConnector(
        { provider: 'notion', operation: 'verify', credential: token },
        async () => new Response(token, { status: 401 }),
      ),
    ).rejects.toThrow('expired or is invalid');
  });
  it('escapes Drive search and exports Google documents', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: any) => {
      urls.push(String(url));
      return urls.length === 1
        ? reply({ files: [] })
        : urls.length === 2
          ? reply({ name: 'Notes', mimeType: 'application/vnd.google-apps.document' })
          : new Response('Hello');
    });
    await runConnector(
      { provider: 'google', operation: 'search', query: "x' or trashed = true", credential: token },
      fetcher,
    );
    expect(new URL(urls[0]).searchParams.get('q')).toBe(
      "trashed = false and fullText contains 'x\\' or trashed = true'",
    );
    const data = await runConnector(
      { provider: 'google', operation: 'read', id: 'abc', credential: token },
      fetcher,
    );
    expect(urls[2]).toContain('/abc/export?mimeType=text%2Fplain');
    expect(data.items[0].text).toBe('Hello');
  });
  it('marks omitted nested Notion content as truncated', async () => {
    const data = await runConnector(
      { provider: 'notion', operation: 'read', id: 'a'.repeat(32), credential: token },
      async () =>
        reply({
          results: [
            {
              type: 'paragraph',
              has_children: true,
              paragraph: { rich_text: [{ plain_text: 'Hello' }] },
            },
          ],
        }),
    );
    expect(data.items[0].text).toBe('Hello');
    expect(data.truncated).toBe(true);
  });
  it('limits upstream response bytes', async () => {
    await expect(
      runConnector(
        { provider: 'github', operation: 'read', id: 'owner/repo', credential: token },
        async () => new Response('x'.repeat(1024 * 1024 + 1)),
      ),
    ).rejects.toThrow('too large');
  });
  it('keeps OAuth secrets private and fixes the redirect URI at configuration time', async () => {
    const env = {
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://brain.test/?account_oauth=google',
    };
    expect(oauthConfig(env)).toEqual({
      google: { clientId: 'client', redirectUri: env.GOOGLE_REDIRECT_URI },
      notion: null,
    });
    expect(
      oauthConfig({ ...env, GOOGLE_REDIRECT_URI: 'https://user:pass@evil.test' }).google,
    ).toBeNull();
    const fetcher = vi.fn(async () =>
      reply({ access_token: token, refresh_token: 'never-return' }),
    );
    expect(
      await exchangeGoogle(
        { code: 'code', verifier: 'a'.repeat(43), redirectUri: 'https://evil.test' },
        env,
        fetcher,
      ),
    ).toEqual({ credential: token });
    expect(String((fetcher.mock.calls[0] as any)[1].body)).toContain(
      encodeURIComponent(env.GOOGLE_REDIRECT_URI),
    );
  });
});

it('exchanges Notion codes with server-only Basic credentials and a fixed redirect', async () => {
  const env = {
    NOTION_CLIENT_ID: 'client',
    NOTION_CLIENT_SECRET: 'secret',
    NOTION_REDIRECT_URI: 'https://brain.test/?account_oauth=notion',
  };
  const fetcher = vi.fn(async () => reply({ access_token: token, refresh_token: 'discard-me' }));
  expect(await exchangeNotion({ code: 'code' }, env, fetcher)).toEqual({ credential: token });
  expect(fetcher.mock.calls[0]).toEqual([
    'https://api.notion.com/v1/oauth/token',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Basic ' + btoa('client:secret') }),
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'code',
        redirect_uri: env.NOTION_REDIRECT_URI,
      }),
    }),
  ]);
});
