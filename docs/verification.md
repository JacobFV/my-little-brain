# Verification — September 5, 2026

Final source checks:

- `npm test`: 168 passing tests across 35 files. Includes camera permission/cancellation/cleanup, tracked observation expiry, bounded visual context replacement, attention IDs, voice interruption, stale connections, persistence validation, server origin/auth checks, and anatomy mesh hashes/topology. Local server tests require permission to bind loopback ports in this managed environment.
- `npm run typecheck`: all seven workspaces pass.
- `npm run build`: web, server and Electron builds pass.
- Linux ARM64 `package:smoke` and the packaged Electron runtime smoke pass: API health, isolated preload, all 28 anatomy assets, and workspace restoration across two launches. The executable is `apps/desktop/release/linux-arm64-unpacked/@little-braindesktop`. The virtual-display smoke uses `--no-sandbox`; normal application configuration enables the renderer sandbox.
- `npm run export:mobile`: iOS and Android JavaScript/assets export succeeds. This is not an installed native-device test.

Browser checks used the running app at `http://127.0.0.1:5173`:

- Real OpenAI `gpt-realtime-2.1` text conversation streamed into the right pane, with persistent thought positions and separate twin histories.
- Actual cortical geometry and the translucent Inside view rendered. Matching left/right glass panes, collapse controls, floating composer and a phone-size layout were inspected.
- Bundled COCO-SSD detected a public sample cat with 93% confidence; one measured inference took 218 ms. Performance varies by hardware and input.
- A full sample-image → local detector → Realtime context → `focus_thought` check passed: the model described the cat and selected its tracked `vision-…` observation ID. A live API failure revealed the 32-character conversation item ID limit; compact IDs and a regression assertion now enforce it.
- A WebRTC receive-only audio check returned a real remote audio track and the transcript “Voice test complete.” No microphone or camera was activated during these browser checks.

The dev-only fixtures are in `apps/web/checks`; they are not application build entry points. Hardware capture, real room conditions, microphone transcription, native camera permissions and sustained mobile performance still need physical-device testing. Automated lifecycle tests exercise capture cancellation and cleanup with fake media streams.

See the desktop/mobile READMEs for packaging commands. Release signing, macOS notarization, Windows builds and installed iOS/Android builds require their respective environments and credentials. Browser/desktop data is local; cross-device sync, IBM-1 integration and EEG inputs are not implemented.


## Living brains extension

- Local data now has validated whole-workspace export/import, conflict/corruption preservation, a browser persistence request, and native Expo snapshots. Automated tests cover archive preservation, exclusion of tokens, native response handling, and failed native restore with recoverable browser preferences. Physical-device native sharing remains untested.
- Actual geometry expanded to 28 meshes, adding fsaverage segmentation-derived cerebellum, brainstem, white matter, ventral diencephalon, corpus callosum and additional ventricles. All meshes are hash/topology checked; details and source limits are in anatomy.md.
- Desktop and 390×844 mobile layouts inspected. Mobile showed no horizontal overflow. Startup greeting, Inside view, fly/butterfly distraction and gaze rendered. Drag orbit moved to a side view and returned fully forward; a low-FPS timing bug was fixed using wall-clock interpolation with regression tests.
- A live OpenAI collaboration between Pip and Moss produced 16 alternating contributions, then stopped with its journal preserved. There is no turn limit. A foreground follow-up correctly recalled the latest suggestion (“Breezy Bean”) and focused the corresponding work-note thought. No outside person was messaged.
- Review caught and fixed file-passage truncation by accounting for the enclosing prompt, stale attention after import, interaction during native restoration, and loss of unfinished background drafts on resume.
- Working connections: camera detection, voice, explicitly selected text-file passages, continuous brain circles, and desktop isolated HTTPS browsing. Computer automation, photo-library and health/EEG adapters are catalogued as unavailable; the app does not claim that their permissions or actions are implemented.
- Background work continues while its runtime is alive, including minimized desktop windows. Mobile OS suspension and application exit remain execution boundaries; interrupted sessions require explicit Resume.

## Interactive workspace and deployment preparation

- Plugin object tests cover position, lifecycle, focus transitions, image races and disposal. Provider tests cover registered tool boundaries, cancellation, stale output and server-owned tool schemas.
- Packaged Electron UI smoke opened an isolated browser, dragged its 3D tablet, focused it, typed into the actual page, toggled audio, returned the tablet and closed the session. Backend smoke covers manual/model control separation and media policy.
- The 390×844 focused interaction view was inspected in Chrome. Its Stop control stopped a real test circle. Physical mobile devices and hardware media sharing remain untested.
- Cloudflare Worker tests cover HTTP/auth/relay boundaries. Local dry-run packaging is supported; no Cloudflare deployment or remote secret configuration was performed.

## Account connections and portals

- Camera and voice tests cover pending permission/play/negotiation timeouts, immediate cancellation, late-track cleanup, StrictMode preview mounting and visible action feedback.
- Account adapter tests cover fixed endpoints, identity verification, read-only operations, byte limits, OAuth state/callback checks, native fetch binding, and Express/Worker authentication. No personal account authorization was performed during verification.
- Portal tests cover continuous exchanges, direct message routing, real image input, cancellation, foreground contention, participant deletion, endpoint changes and back/forward-cache reopen.
- A live Chrome portal between Pip and Moss rendered both scenes and exchanged real OpenAI replies. Asked to describe the image, the peer identified a light pink brain, creamy white eyes and a pale background. Direct message input and Close portal worked. The focused portal was inspected at 390×844; viewport was restored afterward.
- Notion/Google OAuth client values were copied into the ignored local environment under the existing user authorization. Their exact callback URLs still need to be allowed by the provider configuration; no external registration or Cloudflare deployment was performed.

## Interface refinement

- Verified a draft moves from the main prompt into the open chat pane and back without duplication or loss. The phone-sized chat uses the same single prompt.
- Inspected the selected-brain highlight, tighter sidebar, round eyes even at zero focus, minimal chat text, actual locally served integration logos, and concise settings with a working Privacy & terms view.
- All 168 tests, seven workspace typechecks, production build and Cloudflare dry run pass. No deployment was performed.
