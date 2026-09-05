import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { startServer } from './index';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
});
async function serve(options: Parameters<typeof startServer>[0] = {}) {
  const server = await startServer({ port: 0, apiKey: '', accessToken: '', ...options });
  servers.push(server);
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('No address');
  return `http://127.0.0.1:${a.port}`;
}
describe('local API server', () => {
  it('reports configuration without revealing credentials', async () => {
    const base = await serve({ apiKey: 'test-key-never-expose' });
    const text = await (await fetch(base + '/api/health')).text();
    expect(text).toContain('"configured":true');
    expect(text).not.toContain('test-key');
  });
  it('denies untrusted origins and missing tokens before upstream access', async () => {
    const base = await serve({ apiKey: 'test-key', accessToken: 'private-token' });
    const body = JSON.stringify({ brain: { name: 'Pip', personality: 'Curious' }, sdp: 'v=0' });
    expect(
      (
        await fetch(base + '/api/session', {
          method: 'POST',
          headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + '/api/session', {
          method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(401);
  });
  it('returns an actionable missing-key error', async () => {
    const base = await serve();
    const response = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('OPENAI_API_KEY');
  });
  it('forwards successful SDP and keeps upstream errors private', async () => {
    const seen: string[] = [];
    const base = await serve({
      apiKey: 'secret-test-key',
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String((init?.body as FormData).get('session'))).model);
        return new Response('v=0\r\nanswer', { status: 200 });
      },
    });
    const response = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: { name: 'Pip', personality: 'Kind' }, sdp: 'v=0\r\n' }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('answer');
    expect(seen).toEqual(['gpt-realtime-2.1']);
    const failed = await serve({
      apiKey: 'secret-test-key',
      fetchImpl: async () => new Response('private upstream details', { status: 429 }),
    });
    const result = await fetch(failed + '/api/session', {
      method: 'POST',
      headers: { Origin: failed, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brain: { name: 'Pip', personality: 'Kind' }, sdp: 'v=0' }),
    });
    expect(result.status).toBe(429);
    expect(await result.text()).not.toContain('private upstream');
  });
  it('reports missing credentials over WebSocket and closes cleanly', async () => {
    const base = await serve();
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/realtime', { origin: base });
    const event = await new Promise<any>((resolve, reject) => {
      socket.on('open', () =>
        socket.send(
          JSON.stringify({ type: 'connect', brain: { name: 'Pip', personality: 'Kind' } }),
        ),
      );
      socket.on('message', (data) => resolve(JSON.parse(data.toString())));
      socket.on('error', reject);
    });
    expect(event.type).toBe('brain.error');
    expect(event.message).toContain('OPENAI_API_KEY');
    socket.close();
  });
  it('refuses unauthenticated non-loopback hosting', async () => {
    await expect(startServer({ port: 0, host: '0.0.0.0', accessToken: '' })).rejects.toThrow(
      'APP_ACCESS_TOKEN',
    );
  });
});
