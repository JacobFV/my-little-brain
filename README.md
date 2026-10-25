# My Little Brain

A chat agent with a smart, brainy personality that knows you — your uploaded personal notes and your live EEG
(OpenBCI) — and is obsessed with doing neuroscience research on you, using quantum infrastructure.

You talk to your brain. It looks at your EEG spectrograms with Gemini vision, picks channels, and dispatches
QAOA circuits (IonQ trapped ions, IBM heavy-hex, qBraid multi-vendor QPUs/simulators) and an Extropic THRML
thermodynamic surrogate to search 256 Wilson–Cowan neural-mass hypotheses that explain the rhythms it sees.
Results are model hypotheses, not diagnoses.

```
apps/web          the app (React + Vite): chat, 3D brain, analysis pane, jobs sidebar
packages/brain    the 3D brain (three.js): eyes, blinking, moods, EEG/fiber overlay
research/backend  FastAPI: chat agent, quantum backends registry, jobs, EEG, Firestore/GCS
research/bridge   OpenBCI → browser/cloud bridge (BrainFlow)
research/deploy   one Cloud Run service: my-little-brain
```

**Config:** one root `.env` (gitignored) for everything.

**Run locally:** `npm install && npm run demo` (or `research/bridge/demo.sh cyton` with the headset) → http://127.0.0.1:5173

**Deploy:** `npm run deploy` (see `research/deploy/README.md`).

Docs: `docs/cortex2-hackathon.md` (science + design), `docs/cortex2-api.md` (API).
