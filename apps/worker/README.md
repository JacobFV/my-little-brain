# Cloudflare package — prepared, not deployed

This Worker serves the built web app and implements its two Realtime transports using Cloudflare's native `fetch` and `WebSocketPair` APIs. It imports the same OpenAI session configuration as the local Express server. No Express server runs at the edge.

The checked-in configuration exposes no workers.dev URL, preview URL, custom domain, or route. There is no deployment script or automatic deployment workflow. `dry-run` only creates a local bundle. See [the deployment preparation guide](../../docs/cloudflare.md) before any future release.

From the repository root:

```sh
npm run build --workspace @little-brain/web
npm test --workspace @little-brain/worker
npm run typecheck --workspace @little-brain/worker
WRANGLER_SEND_METRICS=false npm run dry-run --workspace @little-brain/worker
```

To use the local Workers runtime, copy `.dev.vars.example` to `.dev.vars` in this directory and fill in both values privately, then run:

```sh
WRANGLER_SEND_METRICS=false npm run dev --workspace @little-brain/worker
```

Open the URL Wrangler prints (normally `http://localhost:8787`). Enter the local `APP_ACCESS_TOKEN` in the app's Settings. The default server URL is the current origin. `.dev.vars` is ignored and is never a static asset. Local development with a real OpenAI key makes real OpenAI requests, but does not deploy a Worker.

`/api/health` is public and contains only readiness/model information. `/api/session` requires a bearer token, an allowed Origin, and a bounded SDP request. `/api/realtime` checks Origin at upgrade, requires the token in the first `connect` message within five seconds, and opens the upstream socket only after authentication. The Worker requires a token of at least 24 characters even in local development. Authentication is for a private, shared-token installation; it is not a multi-user account system.

No Cloudflare database, KV, bucket, Durable Object, or journal-sync endpoint is configured. Web journals remain in browser storage. Selected conversation context transits the Worker to OpenAI for text; WebRTC audio flows between the browser and OpenAI after the Worker exchanges SDP. Camera inference stays in the browser; only detected labels/positions enter context.
