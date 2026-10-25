# @little-brain/brain

Three.js scene for My Little Brain. Import `BrainScene` and give its parent a height. Actual public fsaverage cortical and ENIGMA subcortical template meshes load from the app's own `/anatomy` assets. Animated eyes, optic nerves and lower attachments remain stylized character features. See [anatomy provenance](../../docs/anatomy.md).

Set `anatomyMode` to show translucent cortex and the internal structures. All assets are bundled with web and desktop output. A missing or invalid surface displays a retry state, with no procedural replacement presented as anatomy.

Thought coordinates are normalized screen coordinates: `(-1, -1)` is the upper-left corner, `(1, 1)` is the lower-right. The same foreground plane drives gaze and HTML label positioning. Pass `onThoughtMove` to persist drag updates. Thought buttons support ordinary keyboard focus and activation.

`paused` freezes motion and gaze. `reducedMotion` disables breathing, bobbing, blinking, and spring transitions while preserving instant attention changes. Renderer creation or context loss displays an accessible fallback without preventing interaction with thoughts. The component disposes observers, animation frames, geometry, materials, shadows, and renderer on unmount.

Run `npm run typecheck --workspace @little-brain/brain` from the repository root after installing workspace dependencies.
