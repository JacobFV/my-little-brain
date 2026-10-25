import { expect, it, vi } from 'vitest';
import { createWorker, type Env } from './index';
it('Worker account routes authenticate, sanitize and use the shared adapters', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 1, login: 'Octocat' })));
  const worker = createWorker(fetcher),
    token = 's'.repeat(32);
  const env: Env = { ASSETS: { fetch: async () => new Response('') }, APP_ACCESS_TOKEN: token };
  const req = (origin: string, authorization: string) =>
    new Request('https://brain.test/api/accounts/run', {
      method: 'POST',
      headers: { Origin: origin, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        operation: 'verify',
        credential: 'account-token',
      }),
    });
  expect((await worker.fetch(req('https://evil.test', `Bearer ${token}`), env)).status).toBe(403);
  expect((await worker.fetch(req('https://brain.test', ''), env)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  const config = await worker.fetch(
    new Request('https://brain.test/api/accounts/config', {
      method: 'POST',
      headers: {
        Origin: 'https://brain.test',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    env,
  );
  expect(config.status).toBe(200);
  expect(await config.json()).toEqual({ google: null, notion: null });
  const result = await worker.fetch(req('https://brain.test', `Bearer ${token}`), env);
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect(await result.json()).toEqual({ label: 'Octocat', items: [] });
});
