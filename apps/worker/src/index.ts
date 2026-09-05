import {
  runConnector,
  oauthConfig,
  exchangeGoogle,
  exchangeNotion,
  ConnectorError,
} from '../../server/src/connectors';
import { timingSafeEqual } from 'node:crypto';
import {
  originAllowed,
  sanitizeToolUpdate,
  publicUpstreamError,
  sessionConfig,
  validateConnect,
} from '../../server/src/config';

export type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OPENAI_API_KEY?: string;
  APP_ACCESS_TOKEN?: string;
  OPENAI_REALTIME_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  NOTION_REDIRECT_URI?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};
const EVENT_LIMIT = 256 * 1024;
const ENCODER = new TextEncoder();
const ALLOWED_EVENTS = new Set([
  'conversation.item.create',
  'conversation.item.delete',
  'response.create',
  'response.cancel',
  'conversation.item.truncate',
  'input_audio_buffer.clear',
]);
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http: https: ws: wss:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'";
export function authorized(expected: string | undefined, provided: unknown) {
  if (!expected || expected.length < 24 || typeof provided !== 'string') return false;
  const a = ENCODER.encode(expected),
    b = ENCODER.encode(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
function trusted(request: Request, env: Env) {
  return originAllowed(
    request.headers.get('Origin') || undefined,
    new URL(request.url).host,
    (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
function headers(request: Request, env: Env, api = true) {
  const result = new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  });
  if (api) result.set('Cache-Control', 'no-store');
  if (api && trusted(request, env)) {
    result.set('Access-Control-Allow-Origin', request.headers.get('Origin')!);
    result.set('Vary', 'Origin');
    result.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    result.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return result;
}
function json(request: Request, env: Env, status: number, value: unknown) {
  const h = headers(request, env);
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(value), { status, headers: h });
}
async function limitedJSON(request: Request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw new Error('Invalid JSON request.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid JSON request.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) throw new Error('Request exceeds 128 KB.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
// Injectable transport keeps the relay lifecycle testable without an OpenAI call.
export function relay(
  client: WebSocket,
  env: Env,
  requestFetch: typeof fetch = fetch,
  onClose = () => {},
) {
  let upstream: WebSocket | undefined;
  let phase: 'auth' | 'connecting' | 'ready' | 'closed' = 'auth';
  const abort = new AbortController();
  let handshake: ReturnType<typeof setTimeout> | undefined;
  const authTimer = setTimeout(() => close(1008, 'Connection settings required'), 5000);
  const lifespan = setTimeout(() => close(1000, 'Session time limit reached'), 55 * 60 * 1000);
  let count = 0,
    windowStart = Date.now();
  const close = (code = 1000, reason = 'Realtime session ended') => {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(authTimer);
    clearTimeout(handshake);
    clearTimeout(lifespan);
    abort.abort();
    try {
      client.close(code, reason);
    } catch {}
    try {
      upstream?.close(code, reason);
    } catch {}
    onClose();
  };
  const send = (event: unknown) => {
    if (phase !== 'closed') {
      try {
        client.send(JSON.stringify(event));
      } catch {
        close();
      }
    }
  };
  const fail = (message: string) => {
    send({ type: 'brain.error', message });
    close(1011, 'Session unavailable');
  };
  client.addEventListener('close', () => close());
  client.addEventListener('error', () => close(1011, 'Connection failed'));
  client.addEventListener('message', (event) => {
    if (phase === 'closed') return;
    if (Date.now() - windowStart >= 1000) {
      count = 0;
      windowStart = Date.now();
    }
    if (++count > 60) {
      close(1008, 'Too many events');
      return;
    }
    if (typeof event.data !== 'string' || ENCODER.encode(event.data).length > EVENT_LIMIT) {
      close(1009, 'Invalid or oversized message');
      return;
    }
    let value: any;
    try {
      value = JSON.parse(event.data);
    } catch {
      close(1008, 'Invalid JSON');
      return;
    }
    if (phase === 'auth') {
      clearTimeout(authTimer);
      if (!validateConnect(value)) {
        fail('Invalid connection settings.');
        return;
      }
      if (!authorized(env.APP_ACCESS_TOKEN, value.token)) {
        fail('Enter the server access token in Settings.');
        return;
      }
      if (!env.OPENAI_API_KEY) {
        fail('Configure the server OpenAI secret to wake up your brain.');
        return;
      }
      phase = 'connecting';
      handshake = setTimeout(() => fail('OpenAI took too long to start. Please try again.'), 25000);
      const model = env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
      void requestFetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        signal: abort.signal,
      })
        .then(async (response) => {
          const socket = response.webSocket;
          if (phase === 'closed') {
            if (socket) {
              socket.accept();
              socket.close(1000, 'Client disconnected');
            } else await response.body?.cancel();
            return;
          }
          if (response.status !== 101 || !socket) {
            await response.body?.cancel();
            fail(publicUpstreamError(response.status));
            return;
          }
          upstream = socket;
          socket.accept();
          socket.addEventListener('message', (message) => {
            if (phase === 'closed') return;
            if (
              typeof message.data !== 'string' ||
              ENCODER.encode(message.data).length > 2 * 1024 * 1024
            ) {
              fail('Invalid upstream response.');
              return;
            }
            let data: any;
            try {
              data = JSON.parse(message.data);
            } catch {
              return;
            }
            if (data?.type === 'session.updated' && phase === 'connecting') {
              phase = 'ready';
              clearTimeout(handshake);
              send({ type: 'brain.ready', model });
            }
            if (data?.type === 'session.created' || data?.type === 'session.updated') return;
            if (data?.type === 'error') {
              send({
                type: 'brain.error',
                message: 'The Realtime request failed. Try again or reconnect.',
              });
              return;
            }
            send(data);
          });
          socket.addEventListener('close', () => close());
          socket.addEventListener('error', () => fail('Could not connect to OpenAI. Try again.'));
          socket.send(
            JSON.stringify({
              type: 'session.update',
              session: sessionConfig(value.brain, 'text', model),
            }),
          );
        })
        .catch(() => {
          if (phase !== 'closed') fail('Could not connect to OpenAI. Try again.');
        });
    } else if (phase === 'ready' && upstream) {
      if (value?.type === 'session.update') {
        const safe = sanitizeToolUpdate(value);
        if (!safe) {
          send({ type: 'brain.error', message: 'Only known plugin tools can be updated.' });
          return;
        }
        try {
          upstream.send(JSON.stringify(safe));
        } catch {
          fail('Realtime connection was interrupted.');
        }
        return;
      }
      if (!value || !ALLOWED_EVENTS.has(value.type)) {
        send({ type: 'brain.error', message: 'Unsupported session event.' });
        return;
      }
      try {
        upstream.send(JSON.stringify(value));
      } catch {
        fail('Realtime connection was interrupted.');
      }
    }
  });
  return close;
}
export function createWorker(requestFetch: typeof fetch = fetch) {
  let active = 0; // Per-isolate protection only; not a global account quota.
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/')) {
        const asset = await env.ASSETS.fetch(request);
        const response = new Response(asset.body, asset);
        headers(request, env, false).forEach((v, k) => response.headers.set(k, v));
        return response;
      }
      if (request.method === 'OPTIONS')
        return new Response(null, {
          status: trusted(request, env) ? 204 : 403,
          headers: headers(request, env),
        });
      if (path === '/api/health' && request.method === 'GET')
        return json(request, env, 200, {
          ok: true,
          configured:
            Boolean(env.OPENAI_API_KEY) &&
            Boolean(env.APP_ACCESS_TOKEN && env.APP_ACCESS_TOKEN.length >= 24),
          model: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
          requiresToken: true,
        });
      if (path.startsWith('/api/accounts/')) {
        if (!trusted(request, env))
          return json(request, env, 403, { error: 'This origin is not allowed.' });
        if (
          !authorized(
            env.APP_ACCESS_TOKEN,
            request.headers.get('Authorization')?.replace(/^Bearer /, ''),
          )
        )
          return json(request, env, 401, { error: 'Enter the server access token in Settings.' });
        if (path === '/api/accounts/config' && request.method === 'GET')
          return json(request, env, 200, oauthConfig(env));
        if (request.method !== 'POST')
          return json(request, env, 405, { error: 'Use POST for account requests.' });
        let input: any;
        try {
          input = await limitedJSON(request);
        } catch {
          return json(request, env, 400, { error: 'Invalid account request.' });
        }
        if (JSON.stringify(input).length > 16384)
          return json(request, env, 413, { error: 'Account request is too large.' });
        try {
          if (path === '/api/accounts/config') return json(request, env, 200, oauthConfig(env));
          if (path === '/api/accounts/run')
            return json(request, env, 200, await runConnector(input, requestFetch));
          if (path === '/api/accounts/notion-exchange')
            return json(request, env, 200, await exchangeNotion(input, env, requestFetch));
          if (path === '/api/accounts/google-exchange')
            return json(request, env, 200, await exchangeGoogle(input, env, requestFetch));
          return json(request, env, 404, { error: 'Not found' });
        } catch (error) {
          return json(request, env, error instanceof ConnectorError ? error.status : 502, {
            error: error instanceof ConnectorError ? error.message : 'The account request failed.',
          });
        }
      }
      if (path !== '/api/session' && path !== '/api/realtime')
        return json(request, env, 404, { error: 'Not found' });
      if (!trusted(request, env))
        return json(request, env, 403, { error: 'This origin is not allowed.' });
      if (!env.APP_ACCESS_TOKEN || env.APP_ACCESS_TOKEN.length < 24)
        return json(request, env, 503, {
          error: 'Configure a server access token of at least 24 characters.',
        });
      if (path === '/api/realtime') {
        if (
          request.method !== 'GET' ||
          request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
        )
          return json(request, env, 426, { error: 'WebSocket upgrade required.' });
        if (active >= 8)
          return json(request, env, 429, { error: 'Too many active sessions. Try again shortly.' });
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        active++;
        relay(server, env, requestFetch, () => {
          active--;
        });
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: headers(request, env),
        });
      }
      if (request.method !== 'POST')
        return json(request, env, 405, { error: 'Use POST for a voice session.' });
      if (
        !authorized(
          env.APP_ACCESS_TOKEN,
          request.headers.get('Authorization')?.replace(/^Bearer /, ''),
        )
      )
        return json(request, env, 401, { error: 'Enter the server access token in Settings.' });
      if (!env.OPENAI_API_KEY)
        return json(request, env, 503, {
          error: 'Configure the server OpenAI secret to wake up your brain.',
        });
      let input: any;
      try {
        input = await limitedJSON(request);
      } catch {
        return json(request, env, 400, { error: 'Invalid JSON or oversized session request.' });
      }
      if (
        !validateConnect({ type: 'connect', brain: input?.brain }) ||
        typeof input?.sdp !== 'string' ||
        !input.sdp.startsWith('v=0')
      )
        return json(request, env, 400, { error: 'Invalid session request.' });
      const body = new FormData();
      body.set('sdp', input.sdp);
      body.set(
        'session',
        JSON.stringify(
          sessionConfig(input.brain, 'audio', env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'),
        ),
      );
      try {
        const upstream = await requestFetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
          body,
          signal: AbortSignal.timeout(20000),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          return json(request, env, upstream.status === 429 ? 429 : 502, {
            error: publicUpstreamError(upstream.status),
          });
        }
        const h = headers(request, env);
        h.set('Content-Type', 'application/sdp');
        return new Response(await upstream.text(), { headers: h });
      } catch {
        return json(request, env, 502, { error: 'Could not connect to OpenAI. Try again.' });
      }
    },
  };
}
export default createWorker();
