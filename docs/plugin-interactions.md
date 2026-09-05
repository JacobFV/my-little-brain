# Plugin interaction objects

Every active camera, voice, file, circle or isolated-browser interaction receives its own object in the brain’s foreground workspace. Objects belong to a twin and exist in memory for that interaction; screenshots and positions are not added to the saved journal. The latest active object attracts the eyes, and a focused object takes priority.

Drag a tile with a pointer or touch to place it. Tap or press Enter to expand it toward the viewing plane. Arrow keys move selected objects. Close returns the object to its prior position; the brain view still supports orbiting and automatic return. On compact screens the side panes close when an object is focused.

## Browser sessions

Electron creates an isolated, ephemeral HTTPS browser session. The tablet receives local screenshots from that session. Focused view maps cursor and touch coordinates into the actual page, supports swipe scrolling and keyboard input, and provides a Keyboard field for touch users. The native session window exposes full browser interaction and site device-selection dialogs.

Brain control is opt-in when creating the session. Only the owning twin receives that session’s tool capability; page text requested by the model enters OpenAI context. Screenshots remain local. Manual control is independent of model permission and requires the focused view. Closing the browser removes its capability and object.

Audio, microphone and camera controls are explicit. A website must still request microphone/camera access; focusing alone grants neither. Unfocusing or navigating revokes capture permissions and stops active capture. Audio mutes on leaving focus. Arbitrary USB/Bluetooth device forwarding and remote browser streaming are not implemented. Web and Expo do not expose the Electron-only browser adapter.

## Other integrations

Icon tiles describe their active interaction and offer a Stop action. The renderer supports a Notion tile, but no authenticated Notion connector is installed in the application. Computer automation, photo library and EEG integrations remain visibly unavailable. Adding an integration requires an actual adapter and capability boundary, not only an icon.

Background circles continue until stopped while the app runtime remains alive. Mobile suspension and app exit interrupt work; journals persist locally and can be explicitly resumed.
