import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorized, createWorker, relay, type Env } from './index';
const token = 't'.repeat(32);
const env: Env = {
  ASSETS: {
    fetch: async () =>
      new Response('<html>Brain</html>', { headers: { 'Content-Type': 'text/html' } }),
  },
  APP_ACCESS_TOKEN: token,
  OPENAI_API_KEY: 'server-only-fixture-key',
};
function req(path = '/api/session', options: RequestInit = {}) {
  return new Request(`https://brain.example${path}`, {
    method: 'POST',
    ...options,
    headers: {
      Origin: 'https://brain.example',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    body:
      options.method === 'GET'
        ? undefined
        : (options.body ??
          JSON.stringify({ brain: { name: 'Pip', personality: 'Kind' }, sdp: 'v=0\r\n' })),
  });
}
afterEach(() => vi.useRealTimers());
describe('Worker HTTP boundary', () => {
  it('requires a long configured token and rejects cross-origin requests before upstream traffic', async () => {
    const fetcher = vi.fn();
    const worker = createWorker(fetcher as typeof fetch);
    expect(authorized('', token)).toBe(false);
    expect(authorized('short', 'short')).toBe(false);
    expect(authorized(token, token)).toBe(true);
    expect((await worker.fetch(req(), { ...env, APP_ACCESS_TOKEN: '' })).status).toBe(503);
    expect(
      (await worker.fetch(req('/api/session', { headers: { Origin: 'https://bad.example' } }), env))
        .status,
    ).toBe(403);
    expect(
      (await worker.fetch(req('/api/session', { headers: { Authorization: 'Bearer wrong' } }), env))
        .status,
    ).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('permits exact allowlisted origins and returns CORS/no-store headers for SDP exchange', async () => {
    const fetcher = vi.fn(async () => new Response('v=0\r\nanswer'));
    const response = await createWorker(fetcher as typeof fetch).fetch(
      req('/api/session', { headers: { Origin: 'https://mobile.example' } }),
      { ...env, ALLOWED_ORIGINS: 'https://mobile.example' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://mobile.example');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('v=0\r\nanswer');
    const call = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(call[0][1].headers).toEqual({ Authorization: 'Bearer server-only-fixture-key' });
    const config = JSON.parse((call[0][1].body as FormData).get('session') as string);
    expect(config.model).toBe('gpt-realtime-2.1');
    expect(config.output_modalities).toEqual(['audio']);
  });
  it('rejects oversized or invalid bodies and masks upstream errors', async () => {
    const fetcher = vi.fn(async () => new Response('secret-upstream-details', { status: 429 }));
    const worker = createWorker(fetcher as typeof fetch);
    expect(
      (await worker.fetch(req('/api/session', { body: 'x'.repeat(130 * 1024) }), env)).status,
    ).toBe(400);
    expect(
      (await worker.fetch(req('/api/session', { body: JSON.stringify({ sdp: 'bad' }) }), env))
        .status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(429);
    expect(await response.text()).not.toContain('secret-upstream');
  });
  it('keeps API misses separate from SPA assets and never includes credentials in health', async () => {
    const worker = createWorker();
    const health = await worker.fetch(req('/api/health', { method: 'GET' }), env);
    expect(await health.json()).toEqual({
      ok: true,
      configured: true,
      requiresToken: true,
      model: 'gpt-realtime-2.1',
    });
    expect((await worker.fetch(req('/api/nope', { method: 'GET' }), env)).status).toBe(404);
    expect((await worker.fetch(req('/api/realtime', { method: 'GET' }), env)).status).toBe(426);
    const asset = await worker.fetch(new Request('https://brain.example/thoughts'), env);
    expect(await asset.text()).toContain('Brain');
    expect(asset.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
class Socket extends EventTarget {
  sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  accepted = false;
  accept() {
    this.accepted = true;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close(code = 1000, reason = '') {
    this.closed = { code, reason };
  }
  message(value: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: typeof value === 'string' ? value : JSON.stringify(value),
      }),
    );
  }
  get events() {
    return this.sent.map((value) => JSON.parse(value));
  }
}
const connect = { type: 'connect', token, brain: { name: 'Pip', personality: 'Kind' } };
const asWS = (socket: Socket) => socket as unknown as WebSocket;
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe('Worker websocket relay lifecycle', () => {
  it('authenticates before opening upstream and closes on missing settings timeout', () => {
    vi.useFakeTimers();
    const client = new Socket();
    const fetcher = vi.fn();
    const done = vi.fn();
    relay(asWS(client), env, fetcher as typeof fetch, done);
    client.message({ ...connect, token: 'wrong' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(client.events[0].type).toBe('brain.error');
    expect(done).toHaveBeenCalledOnce();
    const idle = new Socket();
    relay(asWS(idle), env, fetcher as typeof fetch);
    vi.advanceTimersByTime(5000);
    expect(idle.closed?.code).toBe(1008);
  });
  it('waits for session.updated, filters config/errors, relays allowed events, and closes both sides', async () => {
    vi.useFakeTimers();
    const client = new Socket(),
      upstream = new Socket();
    const fetcher = vi.fn(async () => ({ status: 101, webSocket: asWS(upstream) }) as Response);
    const done = vi.fn();
    relay(asWS(client), env, fetcher as typeof fetch, done);
    client.message(connect);
    client.message(connect);
    await tick();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(upstream.events[0].type).toBe('session.update');
    client.message({ type: 'response.create' });
    expect(upstream.events).toHaveLength(1);
    upstream.message({ type: 'session.created', secret: 'hidden' });
    upstream.message({ type: 'session.updated', secret: 'hidden' });
    expect(client.events).toEqual([{ type: 'brain.ready', model: 'gpt-realtime-2.1' }]);
    client.message({ type: 'session.update' });
    expect(client.events.at(-1).type).toBe('brain.error');
    client.message({ type: 'response.create' });
    expect(upstream.events.at(-1)).toEqual({ type: 'response.create' });
    upstream.message({ type: 'error', message: 'private detail' });
    expect(JSON.stringify(client.events)).not.toContain('private detail');
    upstream.message({ type: 'response.output_text.delta', delta: 'Hello' });
    expect(client.events.at(-1).delta).toBe('Hello');
    client.dispatchEvent(new Event('close'));
    expect(upstream.closed?.code).toBe(1000);
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending upstream connection and closes a socket which resolves afterwards', async () => {
    vi.useFakeTimers();
    const client = new Socket(),
      upstream = new Socket();
    let resolve!: (value: Response) => void;
    let signal!: AbortSignal;
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    });
    relay(asWS(client), env, fetcher as typeof fetch);
    client.message(connect);
    client.dispatchEvent(new Event('close'));
    expect(signal.aborted).toBe(true);
    resolve({ status: 101, webSocket: asWS(upstream) } as Response);
    await tick();
    expect(upstream.closed).toBeDefined();
    expect(upstream.sent).toEqual([]);
  });
  it('bounds message sizes and rate, and enforces the handshake timeout', async () => {
    vi.useFakeTimers();
    const huge = new Socket();
    relay(asWS(huge), env);
    huge.message('x'.repeat(256 * 1024 + 1));
    expect(huge.closed?.code).toBe(1009);
    const client = new Socket();
    relay(asWS(client), env, vi.fn(() => new Promise(() => {})) as typeof fetch);
    client.message(connect);
    for (let i = 0; i < 60; i++) client.message({ type: 'response.create' });
    expect(client.closed?.code).toBe(1008);
    const slow = new Socket();
    relay(asWS(slow), env, vi.fn(() => new Promise(() => {})) as typeof fetch);
    slow.message(connect);
    vi.advanceTimersByTime(25000);
    expect(slow.closed?.code).toBe(1011);
  });
  it('relays only sanitized tool registration and rejects model/instruction changes', async () => {
    vi.useFakeTimers();
    const client = new Socket(),
      upstream = new Socket();
    const close = relay(
      asWS(client),
      env,
      vi.fn(async () => ({ status: 101, webSocket: asWS(upstream) }) as Response) as typeof fetch,
    );
    client.message(connect);
    await tick();
    upstream.message({ type: 'session.updated' });
    client.message({
      type: 'session.update',
      session: {
        type: 'realtime',
        tools: [
          { type: 'function', name: 'browser_action', description: 'Unsafe client instructions' },
        ],
      },
    });
    expect(upstream.events.at(-1).session.tools[0].description).toContain('explicitly enabled');
    expect(JSON.stringify(upstream.events)).not.toContain('Unsafe client instructions');
    const count = upstream.events.length;
    client.message({
      type: 'session.update',
      session: { type: 'realtime', tools: [], instructions: 'override' },
    });
    expect(upstream.events).toHaveLength(count);
    expect(client.events.at(-1).type).toBe('brain.error');
    close();
  });
});
