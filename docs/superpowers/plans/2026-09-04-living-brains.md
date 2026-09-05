# Living brains implementation

User-authorized scope: preserve data locally, cute startup, fuller anatomy/cord, energy-driven distractions, local twin collaboration/background work, orbit with return, and platform-aware plugins.

Design decisions: local storage is the journal of record; model requests still send selected context to OpenAI. Background work starts explicitly with a topic and no turn limit, can stop, persists results and resumes only on request after interruption. It continues independently of the selected view/twin while the runtime remains alive; no claim of execution after app exit or OS suspension. Plugin cards distinguish functioning adapters from planned platform capabilities. Permission-requiring inputs never start merely from restored preferences.

- Root: energy state and startup animation; plugin catalog, file preview/share, UI integration, final verification.
- Scene implementer: anatomy completeness audit/assets, improved cord, orbit return, distraction geometry and gaze.
- Platform implementer: storage corruption protection, backup/import UI, native local backup, isolated desktop browser adapter.
- Background implementer: continuous collaboration jobs, persisted transcript, cancellation and tests.

Ruling: proceed under the user's explicit implementation request and prior 'implement everything' authorization; no additional design approval gate. Existing managed workspace has no writable git repository, so no commit/worktree operations.

User correction: no turn limit. Sessions continue until stopped/error/exit, with paced requests and bounded rolling model context but no finite turn cap.

Completed: implementation, independent review/fixes,88 passing tests, all6 typechecks, production build, mobile export, packaged desktop runtime. Live16-turn collaboration+Stop and foreground work-note recall/focus verified. Orbit/mobile/distraction visuals inspected. Final validation details in docs/verification.md.
