import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { startServer } from './index';
let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((r) => {
      server!.close(() => r());
      server!.closeAllConnections();
    });
  server = undefined;
});
it('Express account routes enforce origin and app authentication independently of OpenAI configuration', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 1, login: 'Octocat' })));
  server = await startServer({
    port: 0,
    accessToken: 'server-token',
    apiKey: '',
    fetchImpl: fetcher,
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  const run = (headers: Record<string, string>) =>
    fetch(origin + '/api/accounts/run', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        provider: 'github',
        operation: 'verify',
        credential: 'account-token',
      }),
    });
  expect(
    (await run({ Authorization: 'Bearer server-token', Origin: 'https://evil.test' })).status,
  ).toBe(403);
  expect((await run({})).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  const config = await fetch(origin + '/api/accounts/config', {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: 'Bearer server-token',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(config.status).toBe(200);
  expect(await config.json()).toHaveProperty('google');
  const result = await run({ Authorization: 'Bearer server-token' });
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect(await result.json()).toEqual({ label: 'Octocat', items: [] });
});
