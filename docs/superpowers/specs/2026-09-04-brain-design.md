# My Little Brain

Build a personal, local-first assistant with multiple named digital twins. A responsive three-column shell takes inspiration from commandagi AppShell: collapsible left navigation, central scene, and a resizable chat inspector. Electron custom chrome follows jterm's native macOS / custom Linux and Windows distinction.

The main scene is a procedural Three.js brain, pink folded hemispheres, attached eyeballs and optic nerve mesh, brainstem, feathered nerve endings and vertebrae. It faces the viewer. Conversation items receive stable normalized 2D positions on an invisible glass plane in front of it. A damped spring pulls gaze toward the current thought. Thought outlines can be revealed, selected and dragged. Movement represents conversational attention, not an exposure of model reasoning.

Use an npm-workspaces Turborepo. Shared core owns types, thought placement, gaze physics and conversation event reduction. Shared brain owns the 3D scene. Web is React + Vite. The Node API server owns the OpenAI key and relays Realtime connections. Electron embeds the built web UI with isolated preload window controls. Expo shares the web experience in a native WebView shell with configurable server URL and native safe areas.

The default provider is gpt-realtime-2.1, verified in official documentation on 2026-09-04. Text and microphone conversations stream via Realtime; missing credentials and failed connections surface visibly without fake replies. User text opens chat immediately. Context and twins persist locally; API key stays on server. Copy only relevant OpenAI environment variables from commandagi without printing values. Future IBM-1, EEG and video are out of scope, but provider boundary is replaceable.

Tabs: Habitat (brain), Thoughts (conversation memories with focus), Activity (real session events), Settings (voice, motion, thought visibility and connection). Create, rename, select and delete twins. Pausing ends active session and animation. Main floating composer and RHS composer share conversation state.

Verification: core behavioral tests, API credential/origin/input validation and upstream failure tests, TypeScript checks, production builds, Expo export, Electron packaging smoke, browser interaction and screenshot inspection. Real paid API smoke only within this requested integration; no invented successes if account/network unavailable.

## Updated scope from user

The follow-up supersedes the previous camera exclusion. Simplify the app to its essentials: twin switcher, brain, thoughts, a single conversation composer and tucked-away settings. Remove marketing copy, redundant statuses and decorative UI that competes with the brain. Preserve the full RHS conversation and responsive layout.

Use actual open/template cortical and subcortical geometry sourced via win/IBM-1 references, with provenance and license. Keep stylized ocular/nerve/spinal attachments distinct from anatomical template meshes. Add an opt-in inside view to see subcortical anatomy through the cortex.

Add explicit camera mode with local realtime object detection (COCO-SSD MobileNet is acceptable as a smaller/faster alternative to DETR). Show a live preview, detected boxes and label confidence. Stable tracked detections become transient spatial thoughts whose positions follow camera box centers; expired detections leave the current thought plane. Send only concise, uncertain object summaries into Realtime context at bounded cadence, never raw frames. No unsolicited camera activation or model speech. Voice/chat can refer to observations and focus their IDs. Stop camera tracks/inference on off, unmount or switch, clear stale visual context. Future EEG and IBM-1 model integration remain out of scope.
