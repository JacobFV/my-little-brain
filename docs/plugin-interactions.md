# Plugin interaction objects

Every active camera, voice, file, account, portal or isolated-browser interaction receives its own object in the brain’s foreground workspace. Objects belong to a twin and exist in memory for that interaction; screenshots and positions are not added to the saved journal. The latest active object attracts the eyes, and a focused object takes priority.

Drag a tile with a pointer or touch to place it. Tap or press Enter to expand it toward the viewing plane. Arrow keys move selected objects. Close returns the object to its prior position; the brain view still supports orbiting and automatic return. On compact screens the side panes close when an object is focused.

## Browser sessions

Electron creates an isolated, ephemeral HTTPS browser session. The tablet receives local screenshots from that session. Focused view maps cursor and touch coordinates into the actual page, supports swipe scrolling and keyboard input, and provides a Keyboard field for touch users. The native session window exposes full browser interaction and site device-selection dialogs.

Brain control is opt-in when creating the session. Only the owning twin receives that session’s tool capability; page text requested by the model enters OpenAI context. Browser screenshots remain local unless an open brain portal includes that browser surface in a rendered workspace image sent to its peer through OpenAI. Manual control is independent of model permission and requires the focused view. Closing the browser removes its capability and object.

Audio, microphone and camera controls are explicit. A website must still request microphone/camera access; focusing alone grants neither. Unfocusing or navigating revokes capture permissions and stops active capture. Audio mutes on leaving focus. Arbitrary USB/Bluetooth device forwarding and remote browser streaming are not implemented. Web and Expo do not expose the Electron-only browser adapter.

## Other integrations

Notion, Google Drive and GitHub have authenticated read-only adapters and account cards. Their search/read requests create instance tiles and return real provider content; see [account setup](accounts.md). Computer automation, photo library and EEG integrations remain visibly unavailable.

## Brain portals

Connections → Brain portal opens one reciprocal pair between two brains on this device. Each environment is rendered by its own BrainScene, and stable 640px snapshots update portal surfaces at four frames per second. Captures exclude portal planes to bound nesting. Focusing opens the actual peer scene with direct messaging and Close portal. Mouse/touch orbit and the existing return-to-front behavior work in either environment.

Each model turn receives an ephemeral JPEG snapshot of its peer’s rendered environment alongside recent visible thoughts and active plugin labels. Images are not persisted. Completed messages are saved in both twins’ local conversations. Frames carry their brain identity so switching twins cannot mislabel a previous frame.

The portal exchanges real Realtime replies with no turn cap while the runtime is alive. Foreground chat and voice startup suspend conflicting peer turns. Closing, deleting a participant, changing the server or leaving the page cancels work. Returning from browser back/forward cache allows a fresh portal, without automatically resuming the old one. Old Brain Circle journals remain recoverable in local backups; its navigation and runtime are no longer used by the app.
