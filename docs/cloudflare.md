# Cloudflare deployment preparation

Status: **prepared and locally verified; not deployed**. No Cloudflare account, routes, domains, secrets, Access policies, or Workers have been created or modified by this work.

The deployment target is a single Cloudflare Worker with static assets from `apps/web/dist`. The Worker handles `/api/session` (WebRTC SDP) and `/api/realtime` (text WebSocket relay), and returns JSON 404s for missing API routes. All remaining requests go through the asset binding with SPA fallback. Security headers are applied by the Worker to every response, so `run_worker_first` is enabled for all paths. This invokes the Worker for asset requests as well. See [Cloudflare asset binding and routing](https://developers.cloudflare.com/workers/static-assets/binding/).

## What is ready

- `apps/worker/wrangler.jsonc`: pinned compatibility date, Node compatibility for the shared server configuration and constant-time token comparison, assets binding, model defaults, logging disabled, no public routes.
- `apps/worker/src/index.ts`: native HTTP/WebSocket relay, same model/session tool configuration as Express, mandatory server access token, Origin checks, bounded requests, provider-error redaction and connection cleanup.
- Nine focused tests cover authorization/origins, SDP forwarding and limits, static/API routing, WebSocket lifecycle/late connection cancellation, message/rate/handshake limits, redaction, and server-sanitized tool registration.
- Local Wrangler dry-run bundles the Worker without uploading it. The real local Workers runtime served the app and passed health/API-404 checks plus a real WebSocket upgrade, rejected-token error and close. No upstream OpenAI call was needed for that smoke check. Remote Cloudflare/OpenAI routing has not been tested because nothing is deployed.

From the root, build and inspect the exact release locally:

```sh
npm ci
npm run build --workspace @little-brain/web
npm test --workspace @little-brain/worker
npm run typecheck --workspace @little-brain/worker
WRANGLER_SEND_METRICS=false npm run dry-run --workspace @little-brain/worker
```

The local Worker bundle is written to `apps/worker/dist`. Wrangler reads the web assets separately; they are not embedded into the Worker JavaScript bundle. `.env` and `.dev.vars` files are outside the assets directory and must never be copied into it. The pinned Wrangler command's `--dry-run` help confirms that it compiles the Worker without publishing it; [Wrangler's command reference](https://developers.cloudflare.com/workers/wrangler/commands/) describes the CLI entry points.

## Decisions before a future deployment

These are preparation instructions, **not actions already taken**. Deployment still requires an explicit request.

1. Choose the Cloudflare account, Worker name, and a dedicated HTTPS hostname. Prefer a dedicated origin because browser journals are scoped to origins. Changing domains creates a separate local journal: export/import your local backup to move it.
2. Keep `workers_dev: false` and `preview_urls: false`. Choose a custom domain/route only when ready to make the service reachable. Cloudflare documents [workers.dev exposure controls](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) and [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). No account ID or hostname is hardcoded here.
3. Configure Cloudflare Access for that hostname and restrict access to the intended people. Cover the full hostname, including `/api/*`, and test the WebSocket handshake and mobile WebView sign-in. Do not expose an alternate route that bypasses Access. The application token remains mandatory even when Access is enabled: the Worker does not treat an unvalidated `Cf-Access-*` header as authorization. See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
4. Store `OPENAI_API_KEY` and a cryptographically random `APP_ACCESS_TOKEN` (at least 24 characters; 32 random bytes is a suitable choice) as Worker **secrets**. Do not place them in `vars`, `VITE_*`, a URL, source control, or a static file. A future authorized deployment can use Cloudflare's dashboard or `wrangler secret put` for each secret; those commands mutate remote configuration and were not run. See [Cloudflare secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/).
5. Keep `OPENAI_REALTIME_MODEL` at `gpt-realtime-2.1`, or select a model your OpenAI account can use. Leave `ALLOWED_ORIGINS` empty for the same-origin website and Expo wrapper pointing to it. To deliberately connect an existing desktop/web renderer hosted on another origin, list exact origins separated by commas; never use `*`. The mobile wrapper normally loads this same HTTPS origin. Native Electron app localhost ports can change, so pointing the renderer at the hosted origin is simpler than an ephemeral-port allowlist.
6. Choose Cloudflare/OpenAI account usage controls before exposing the shared-token endpoint. The application token authenticates access to one private service, not separate billing identities. Complete remote acceptance checks after a later authorized deployment: HTML/anatomy/detector assets, real text response, voice SDP/audio, camera context, token rejection, and Access coverage. Then test native wrappers against the chosen HTTPS origin.

For initial provisioning, keep the Worker unreachable while installing its secrets and Access policy. Only attach its public custom domain/route as the last release step. This repository does not automate any of those remote mutations.

## Runtime and privacy boundaries

The relay uses Cloudflare's documented outbound `fetch` with `Upgrade: websocket`, accepts the upstream WebSocket, and filters session configuration and raw provider errors. Client close/error, handshake timeout, and session expiry close both sides and abort pending fetches. The implementation follows the current [Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/), including automatic close replies for the configured compatibility date.

Each text connection expires after 55 minutes, with a five-second client-auth deadline and a 25-second upstream handshake deadline. It permits 60 incoming events per second and 256 KiB client messages; upstream messages are limited to 2 MiB. There is an eight-connection cap **per Worker isolate**, not a global user/account cap. A Worker may have multiple isolates, so this cap is not an abuse or billing guarantee. Cloudflare's own [platform limits](https://developers.cloudflare.com/workers/platform/limits/) still apply. Cloudflare runtime updates or network disconnects can end a socket; foreground conversations reconnect on the next action and interrupted circle work requires explicit Resume. Circle turns create fresh sessions and retain their full journal locally.

WebRTC sessions exchange SDP through the Worker, then microphone audio uses the direct peer connection to OpenAI. The 55-minute relay timer only applies to text WebSockets. Circle work still runs while the client app is open, including when another view is selected; this Worker adds no autonomous cloud scheduler and stores no personal journal. Closing the app stops its work.

Persistent personal data stays on the device, as before. Hosting moves static code and transient API transport to Cloudflare; it does not make inference local or end-to-end encrypt selected text against the Worker/OpenAI. The Worker writes no request bodies, messages, tokens, or API keys to logs and has observability disabled. Cloudflare and OpenAI still process network traffic needed to provide their services. Any future logging change should preserve this boundary.
