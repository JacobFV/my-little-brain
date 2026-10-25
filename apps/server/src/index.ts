import express from 'express';
import { createServer, type Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import WebSocket, { WebSocketServer } from 'ws';
import {
  authorized,
  sanitizeToolUpdate,
  originAllowed,
  publicUpstreamError,
  sessionConfig,
  validateConnect,
} from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
export type ServerOptions = {
  port?: number;
  host?: string;
  staticDir?: string;
  apiKey?: string;
  accessToken?: string;
  origins?: string[];
  model?: string;
  fetchImpl?: typeof fetch;
};
export async function startServer(options: ServerOptions = {}): Promise<Server> {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT || 4318);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const token = options.accessToken ?? process.env.APP_ACCESS_TOKEN ?? '';
  const model = options.model ?? process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
  const origins =
    options.origins ??
    (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && token.length < 24)
    throw new Error('Non-loopback hosting requires APP_ACCESS_TOKEN with at least 24 characters.');
  const requestFetch = options.fetchImpl ?? fetch;
  const app = express();
  app.disable('x-powered-by');
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...origins.map((o) => {
      try {
        return new URL(o).hostname;
      } catch {
        return '';
      }
    }),
  ]);
  const trusted = (req: express.Request) =>
    originAllowed(req.headers.origin, req.headers.host, origins);
  const hostAllowed = (hostHeader: string | undefined) => {
    try {
      return (
        !['localhost', '127.0.0.1', '::1'].includes(host) ||
        allowedHosts.has(new URL(`http://${hostHeader}`).hostname)
      );
    } catch {
      return false;
    }
  };
  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) {
      res.status(403).json({ error: 'Host is not allowed.' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http: https: ws: wss:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'",
    );
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.origin && trusted(req)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        res.sendStatus(trusted(req) ? 204 : 403);
        return;
      }
    }
    next();
  });
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, configured: Boolean(apiKey), model, requiresToken: Boolean(token) }),
  );
  app.post('/api/session', express.json({ limit: '128kb' }), async (req, res) => {
    if (!trusted(req)) {
      res.status(403).json({ error: 'This origin is not allowed.' });
      return;
    }
    if (!authorized(token, req.headers.authorization?.replace(/^Bearer /, ''))) {
      res.status(401).json({ error: 'Enter the server access token in Settings.' });
      return;
    }
    if (!apiKey) {
      res
        .status(503)
        .json({ error: 'Add OPENAI_API_KEY to the server .env to wake up your brain.' });
      return;
    }
    if (
      !validateConnect({ type: 'connect', brain: req.body?.brain }) ||
      typeof req.body.sdp !== 'string' ||
      !req.body.sdp.startsWith('v=0')
    ) {
      res.status(400).json({ error: 'Invalid session request.' });
      return;
    }
    const body = new FormData();
    body.set('sdp', req.body.sdp);
    body.set('session', JSON.stringify(sessionConfig(req.body.brain, 'audio', model)));
    try {
      const upstream = await requestFetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        res
          .status(upstream.status === 429 ? 429 : 502)
          .json({ error: publicUpstreamError(upstream.status) });
        return;
      }
      res.type('application/sdp').send(await upstream.text());
    } catch {
      res
        .status(502)
        .json({ error: 'Could not connect to OpenAI. Check the server network and try again.' });
    }
  });
  const staticDir = options.staticDir ?? path.join(root, 'apps/web/dist');
  if (existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    app.get('/{*path}', (req, res) =>
      req.path.startsWith('/api/')
        ? res.status(404).json({ error: 'Not found' })
        : res.sendFile(path.join(staticDir, 'index.html')),
    );
  }
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({
        error:
          error instanceof SyntaxError
            ? 'Invalid JSON request.'
            : 'Request could not be processed.',
      });
    },
  );
  let active = 0;
  server.on('upgrade', (req, socket, head) => {
    if (
      req.url !== '/api/realtime' ||
      !hostAllowed(req.headers.host) ||
      !originAllowed(req.headers.origin, req.headers.host, origins) ||
      active >= 8
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (client) => sockets.emit('connection', client));
  });
  sockets.on('connection', (client) => {
    active++;
    let upstream: WebSocket | undefined;
    let ready = false;
    let closed = false;
    const send = (event: object) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    };
    const fail = (message: string) => {
      send({ type: 'brain.error', message });
      client.close(1011, 'Session unavailable');
    };
    const authTimer = setTimeout(() => client.close(1008, 'Connection settings required'), 5000);
    let handshake: ReturnType<typeof setTimeout> | undefined;
    const lifespan = setTimeout(
      () => client.close(1000, 'Session time limit reached'),
      55 * 60 * 1000,
    );
    const heartbeat = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, 30000);
    let count = 0;
    const countTimer = setInterval(() => {
      count = 0;
    }, 1000);
    client.on('message', (raw) => {
      if (++count > 60) {
        client.close(1008, 'Too many events');
        return;
      }
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        client.close(1008, 'Invalid JSON');
        return;
      }
      if (!upstream) {
        clearTimeout(authTimer);
        if (!validateConnect(event)) {
          fail('Invalid connection settings.');
          return;
        }
        if (!authorized(token, event.token)) {
          fail('Enter the server access token in Settings.');
          return;
        }
        if (!apiKey) {
          fail('Add OPENAI_API_KEY to the server .env to wake up your brain.');
          return;
        }
        upstream = new WebSocket(
          `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            maxPayload: 2 * 1024 * 1024,
            handshakeTimeout: 20000,
          },
        );
        handshake = setTimeout(
          () => fail('OpenAI took too long to start. Please try again.'),
          25000,
        );
        upstream.on('open', () =>
          upstream?.send(
            JSON.stringify({
              type: 'session.update',
              session: sessionConfig(event.brain, 'text', model),
            }),
          ),
        );
        upstream.on('message', (data) => {
          let value: any;
          try {
            value = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (value.type === 'session.updated' && !ready) {
            ready = true;
            clearTimeout(handshake);
            send({ type: 'brain.ready', model });
          }
          // Never forward provider session configuration to the client.
          if (value.type === 'session.created' || value.type === 'session.updated') return;
          if (value.type === 'error') {
            send({
              type: 'brain.error',
              message: 'The Realtime request failed. Try again or reconnect.',
            });
            return;
          }
          send(value);
        });
        upstream.on('unexpected-response', (_req, response) => {
          response.resume();
          fail(publicUpstreamError(response.statusCode ?? 502));
        });
        upstream.on('error', () => {
          if (!closed) fail('Could not connect to OpenAI. Check the server network and try again.');
        });
        upstream.on('close', () => {
          if (!closed) client.close(1000, 'Realtime session ended');
        });
      } else if (ready && upstream.readyState === WebSocket.OPEN) {
        if (event?.type === 'session.update') {
          const safe = sanitizeToolUpdate(event);
          if (safe) upstream.send(JSON.stringify(safe));
          else send({ type: 'brain.error', message: 'Only known plugin tools can be updated.' });
          return;
        }
        if (
          ![
            'conversation.item.create',
            'conversation.item.delete',
            'response.create',
            'response.cancel',
            'conversation.item.truncate',
            'input_audio_buffer.clear',
          ].includes(event?.type)
        ) {
          send({ type: 'brain.error', message: 'Unsupported session event.' });
          return;
        }
        upstream.send(JSON.stringify(event));
      }
    });
    client.on('error', () => client.close());
    client.on('close', () => {
      closed = true;
      active--;
      clearTimeout(authTimer);
      clearTimeout(handshake);
      clearTimeout(lifespan);
      clearInterval(heartbeat);
      clearInterval(countTimer);
      upstream?.close();
    });
  });
  server.on('close', () => {
    sockets.clients.forEach((c) => c.terminate());
    sockets.close();
  });
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer()
    .then((server) => {
      const address = server.address();
      console.log(
        `My Little Brain server listening on ${typeof address === 'object' && address ? address.address + ':' + address.port : address}`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
