# My Little Brain

A little space for your mind. A local-first companion for your digital twins, with a human-template 3D brain, gravity-like attention, live camera perception, and OpenAI conversations.

## Run it

Requires Node 22.13+ and npm 10.

```sh
npm install
# Create .env from .env.example and set OPENAI_API_KEY if not configured.
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on **127.0.0.1:4318**. The relevant OpenAI credential from `~/Documents/commandagi` has already been copied to the private root `.env` in this workspace. Values are never included in client builds. Do not commit that file.

```sh
npm run dev:desktop       # web + API + Electron together
npm run dev:mobile        # Expo development server (connection setup below)
npm run build            # production web, bundled API, Electron main/preload
npm start                # serve the built app and API on :4318
npm run package:desktop  # build and package Electron for the current OS
npm run export:mobile   # iOS + Android JS/assets, not signed native binaries
npm test                 # core, provider, lifecycle, API, mobile connection tests
npm run typecheck        # all seven workspaces
```

## What it does

- A soft, diffuse-glass workspace centered on the brain. Left navigation and right conversation use the same collapsible, resizable pane component, with a prompt in the open conversation pane and a floating prompt when that pane is minimized. Drafts follow the prompt between views. Enter sends; Shift+Enter inserts a newline. Sending opens the conversation. `Ctrl/Cmd+\` toggles it; Escape closes it.
- 28 actual fsaverage/ENIGMA template meshes, including cerebellum, brainstem, white matter, ventral diencephalon and corpus callosum; **Inside** reveals the internal structures. Connected eyeballs, optic nerves, feathered brainstem endings and spinal vertebrae are stylized character features. See [anatomy and attribution](docs/anatomy.md). Eye orientation follows thoughts on a foreground 2D plane with a damped spring. Idle breathing, bobbing and blinking can be reduced or paused.
- Drag the 3D view to orbit; arrow keys also orbit and Home faces forward. After four seconds without input, the camera returns smoothly over two seconds, including at low frame rates.
- A little waking-up animation greets you on app start. Focus energy drains during idle time and replenishes through work or detected visual input. Low focus manifests a floating mote, butterfly or fly that attracts the eyes. This is a playful simulation, not measured cognition.
- Every message gets a stable spatial position. Reveal **Thoughts** to see and drag them. The model can call `focus_thought` to attend to something already discussed. This represents conversational attention, not access to hidden reasoning.
- Multiple named twins, personalities, colors, isolated conversations, real activity events, thought search, focus, and JSON export. Local browser storage retains data; Electron additionally saves atomically to its app data directory, and Expo keeps an origin-scoped native backup. Settings → Local data exports/imports the complete workspace, tasks, focus and preferences without access tokens, offers browser persistent storage, and preserves corrupt or conflicting saved copies for recovery. There is no cross-device sync.
- **Camera** runs bundled COCO-SSD object detection locally, tracks visible objects on the thought plane, and sends a bounded, replaceable summary to the conversation. The brain can focus its eyes on an observed object. Camera frames stay on the device; only labels, confidence and approximate locations enter OpenAI context. Detection is approximate and hardware-dependent. Turning it off clears visual context and stops capture.
- **Brain portals** connect two local brains through reciprocal, draggable 3D windows. Each renders the other’s actual workspace; a focused portal opens the peer’s scene and conversation. Open portals exchange real Realtime replies with no turn limit until closed, and accept direct messages. Rendered workspace images and visible thought/plugin summaries enter the peer’s model context. Both twins keep the conversation locally. The app supports one open pair at a time and closes portals on page exit rather than restarting them automatically.
- **Connections → Your accounts** offers Notion, Google Drive and GitHub with verified credentials, real search/read previews, and a read-only `connected_account` tool. Notion and Google support configured browser OAuth; all three support tokens on web, desktop and mobile. See [account setup](docs/accounts.md) for scopes and provider callback registration.
- **Open a file** opens a text-file picker and previews the passage before sharing. Camera, voice, file, account and desktop browser interactions each have their own floating object. Camera/voice controls show startup progress, cancellation and actionable permission/device errors.
- Mobile panes collapse around the main scene, with touch dragging and a phone-sized focused portal view. The isolated browser still requires Electron. Computer automation, photo-library and body-signal adapters are visibly unavailable.
- Realtime streaming text through a server WebSocket relay, and microphone/audio through WebRTC. Text works without microphone permission. Missing keys, quota problems and connection failures are visible; the app does not substitute simulated replies.

The configured default is **`gpt-realtime-2.1`**, verified against [OpenAI’s model documentation](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) on September 4, 2026. The implementation follows [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) and [Realtime conversation events](https://developers.openai.com/api/docs/guides/realtime-conversations). Set `OPENAI_REALTIME_MODEL` on the server to override. Each reconnect restores up to 40 recent nonempty messages within a 48,000-character budget; all saved thoughts remain available locally.

## Workspace

```text
apps/web        React + Vite shared experience
apps/server     Express HTTP / WebSocket boundary; server-only OpenAI credentials
apps/desktop    Electron main/preload, native window controls, electron-builder
apps/worker     Cloudflare Worker API + static assets (prepared, not deployed)
apps/mobile     Expo + native WebView, safe areas, connection setup and retry
packages/core   Twin types, persistence validation, thought positions and events
packages/brain  Three.js anatomy, gaze, lighting and interactive thought plane
```

`BrainProvider` in `apps/web/src/provider.ts` is the replaceable provider contract. IBM-1, raw video input to the conversational model, and EEG integration remain future work. Camera object detection is implemented now. Bundled detector weights and their Apache-2.0 license/provenance are in `apps/web/public/vision`. Connected portal brains produce written work; the desktop browser supports user control and optional, explicitly enabled brain control within its isolated session. Camera, microphone, file passage sharing and browsing require explicit user actions.

The shell follows the pane structure in commandagi’s `AppShell`; desktop chrome follows jterm’s platform distinction. This is a self-contained implementation and has no runtime dependency on either reference repo.

## Expo and remote connections

The Expo app shares the complete web scene and chat in a native WebView. It needs a reachable web/API server; it does not bundle a local Node server. The native Connection screen stores the origin. The web Settings screen accepts the server access token, kept for the current session.

For a phone on your local network, the simplest development route is:

1. Build with `npm run build`.
2. In `.env`, set `HOST=0.0.0.0`, a random `APP_ACCESS_TOKEN` of at least 24 characters, and `ALLOWED_ORIGINS=http://YOUR_COMPUTER_IP:4318`.
3. Run `npm start` and `npm run dev:mobile` in separate terminals.
4. Open Expo on your device, choose `http://YOUR_COMPUTER_IP:4318` in Connection, and enter the same access token in web Settings.

HTTP LAN development supports text and 3D. Continuous work runs while the app runtime remains alive. Desktop jobs continue when minimized; mobile OS suspension and app exit stop execution. Nothing claims to be an always-on daemon. Camera and microphone access require HTTPS or a secure localhost context. Production mobile requires an HTTPS origin and a reverse proxy that supports WebSockets. The backend refuses non-loopback binding without a strong access token. Configure explicit allowed origins for separate web/API hosts. For same-origin hosting, the browser origin is accepted automatically.

For installable iOS/Android builds, see [mobile build instructions](apps/mobile/README.md). Native toolchains, Expo project registration and signing credentials are required; they are not part of this repository.

## Desktop packaging

See [desktop details](apps/desktop/README.md). Linux targets AppImage/deb, macOS targets dmg, and Windows targets nsis. Build and sign on the corresponding platform. Signing and notarization require your release credentials.

The packaged app starts a bundled local API on an ephemeral loopback port, with context isolation, sandboxed preload, and restricted window IPC. It restores workspace data independently of that changing port. It does **not** package the development `.env`. Set `OPENAI_API_KEY` in the launch environment or in `.env` under Electron’s `userData` directory, typically `~/.config/My Little Brain` on Linux. Conversation exports and local storage are plaintext personal data.

## Verification

See [verification notes](docs/verification.md) for the actual checks and platform limits from this implementation. Source is maintained in the private [GitHub repository](https://github.com/JacobFV/my-little-brain). Cloudflare configuration is prepared but has not been deployed. Run `npm run cloudflare:prepare` to build and perform a local deployment dry run; see [Cloudflare setup](docs/cloudflare.md).
