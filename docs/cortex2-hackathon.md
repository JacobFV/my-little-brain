# cortex² — the quantum brain detective

> We gave an AI a quantum computer and asked it to reverse-engineer the brain.

cortex² is a research lab built on the My Little Brain renderer. A Gemini 4 Argon agent designs,
compiles, runs and revises 8-qubit circuits that search the hypothesis space of a neural-mass
model for the parameters that best explain an observed EEG signature: synthetic, an OpenBCI
headset, or a CHB-MIT seizure recording.

## What is new in this hackathon (judge provenance)

My Little Brain existed before the event. That covers the anatomical meshes, the eyes, blinking,
gaze, the pane layout and the companion app. Everything below was built during the hackathon:

| area | files |
|---|---|
| neural forward model (Wilson–Cowan, batched, seeded) | `research/backend/cortex2/neural.py` |
| inverse problem, 5 QUBO approximations, Ising map, evaluation | `research/backend/cortex2/inverse.py` |
| QAOA (numpy angle optimisation + Qiskit), agent-QASM validation, transpile/gate accounting, Aer, IBM Runtime | `research/backend/cortex2/quantum.py` |
| Extropic THRML thermodynamic sampler of the same Ising model | `research/backend/cortex2/thermo.py` |
| classical baselines (exact, annealing, random) | `research/backend/cortex2/classical.py` |
| AI circuit engineer + long-running operator (tools, vision) | `research/backend/cortex2/agent.py` |
| multi-provider model layer: Gemini / OpenAI adapters, ordered failover across keys | `research/backend/cortex2/llm.py` |
| jobs, experiments, IBM polling, rendering | `runner.py`, `render.py` |
| Firestore / GCS / Cloud Tasks persistence | `store.py`, `tasks.py` |
| FastAPI service | `app.py` (contract: `docs/cortex2-api.md`) |
| CHB-MIT excerpt + EDF reader | `research/data/chbmit/`, `cortex2/eeg.py` |
| OpenBCI bridge (BrainFlow → local WebSocket + cloud) | `research/bridge/openbci.py` |
| reproducible benchmark | `research/experiments/benchmark.py`, `BENCHMARK.md` |
| `/lab` UI, tractography overlay, quantum visualisations | `apps/web/src/research/*`, `packages/brain/src/research.ts` + overlay in `index.tsx` |
| GCP deploy | `research/Dockerfile`, `research/deploy/*` |

## The science, and what we claim and don't claim

- **Forward model.** This is a two-population Wilson–Cowan column driven by seeded noise. The parameters are
  excitatory drive P ∈ {1.5, 2, 2.5, 3}, inhibitory gain c2 ∈ {10, 13, 16, 19}, recurrent
  excitation c1 ∈ {12, 14, 16, 18} and synaptic τ ∈ {8, 16, 30, 55} ms. That gives 2 bits per
  parameter, 8 qubits and 256 hypotheses. Features are 10 relative log band powers (1–45 Hz) plus
  log amplitude. Amplitude is ignored for real EEG because its units differ from the model's.
- **Objective.** θ* = argmin‖f(θ) − y‖²_W, with W = 1/spread² per feature. Synthetic "recordings" use a
  different noise seed from the model. The consistent set is every hypothesis that lies
  within the stochastic noise floor of the best.
- **Quantum and thermodynamic bridge.** The nonlinear loss is approximated by a QUBO. The available
  approximations are secant, Jacobian, loss regression, feature regression, and trust-region around
  the best-so-far hypothesis. The QUBO maps exactly to an Ising model, which can then be:
  - sampled by QAOA, with the circuit either written by the agent or specified structurally, then
    simulated on Aer (ideal or IBM noise model) or run on an IBM QPU;
  - sampled by Extropic's THRML Gibbs sampler;
  - solved by simulated annealing.
  Every sample is decoded and re-simulated. Only the K=8 most frequent states are validated,
  because 1k shots over 256 states would otherwise just enumerate the space.
- **Gate budget.** The ~130-gate budget applies to the *transpiled physical* circuit on IBM heavy-hex.
  For example, full p=1 QAOA costs 424 physical gates on Torino, while pruning to the 6 strongest
  couplings brings it to about 105. Trading off fidelity against the budget is the agent's job.
- **Real EEG.** On CHB-MIT chb01_03, the pre-ictal and ictal segments land on *different* best
  hypotheses. The ictal segment shows higher excitatory drive and slower dynamics (P 2→3, τ 16→55 ms),
  consistently across channels. These are configurations of a simplified model consistent with the
  data, **not seizure causes and not a diagnosis**.
- **Not claimed:**
  - Quantum advantage. 256 states are trivially enumerable classically.
  - Tractography. The fibers are an illustrative overlay.
  - Physical Extropic hardware. THRML is their open-source software stack, and no hosted API exists.

## The agent (the "never been done" part)

A design iteration is construct → compile → run → render → observe → critique → revise:

1. Gemini 4 Argon calls `inspect_state`, `build_problem`, `compile_circuit` and
   `run_experiment`. It can write its **own OpenQASM 2.0**, which is parsed as data and never executed as code.
   The circuit is validated, transpiled to IBM heavy-hex, gate-counted, and executed.
2. After each run, the model receives the rendered comparison image: waveforms, features,
   sampled states, landscape and sample distribution. If the user's 3D lab view has been captured,
   that snapshot is sent too.
3. `record_revision` stores the observation, diagnosis, change, rationale, spec diff and QASM diff.
   The verdict (improved / regressed / unchanged) is **computed from measured metrics**. The model
   cannot mark its own work as an improvement.
4. The **operator** is the long-running session. It keeps a rolling memory and sees every job.
   It can dispatch, cancel, retry and poll work, and start iterations. It runs inside a
   transactional budget. Autonomous QPU use needs an explicit opt-in.
   Cloud Scheduler wakes it every 5 minutes to babysit IBM queues and stuck jobs.

### Model providers

`AGENT_PROVIDERS` is an ordered chain of `family:KEY_ENV[@model]` entries, for example:

```
gemini:GEMINI_API_KEY,gemini:GEMINI_API_KEY_B,gemini:GEMINI_API_KEY_C,gemini:GEMINI_API_KEY_B@gemini-3.8-flash,openai:OPENAI_API_KEY
```

The default model is `GEMINI_MODEL=gemini-4-argon`. Conversations are stored in a provider-neutral format, so if a
key hits a quota, rate-limit, billing or outage error, the next entry continues the *same* tool loop. A failing
key cools down for 1–60 minutes, and every turn records which provider answered. The answering providers
are stored on each revision as `provenance`, and `/v1/config` → `model_providers` shows the chain's live status.

**First live run** (local, `gemini-4-argon`) on the synthetic alpha-rhythm experiment `10101011`, starting from a naive
in-budget QAOA baseline with loss 3.096 against a minimum of 0.086 on 106 physical gates:
- Argon inspected the state and compared four QUBO approximations by Spearman rank fidelity.
- It found that the local linearisation ranked the true hypothesis 229/256.
- It switched to a global feature-regression QUBO, compiled it, and ran it on the IBM-noise simulator.
- The system-computed verdict was **improved**: loss went 3.096 → 0.632, P(consistent) went 0.001 → 0.018, and the
  circuit dropped to 99 physical gates.
- Its proposed next step was to re-anchor the trust region around the new best `10111111`, which is
  2 bits from the truth.

## Run locally

```bash
# python (3.12)
uv venv research/.venv --python 3.12
VIRTUAL_ENV=research/.venv uv pip install -r research/backend/requirements.txt pytest httpx brainflow websockets
cd research/backend && ../.venv/bin/python -m pytest -q tests      # 24 tests
set -a; source ../.env; set +a                                        # DEV_AUTH=1 enables "Continue as dev"
../.venv/bin/uvicorn api:app --port 8080 --reload

# web (repo root, separate terminal)
npm install && npm run dev:web          # http://127.0.0.1:5173/lab  (vite proxies /v1 → :8080)

# headset (separate terminal)
research/.venv/bin/python research/bridge/openbci.py --board synthetic
research/.venv/bin/python research/bridge/openbci.py --board cyton --serial-port /dev/cu.usbserial-XXXX
```
Locally, the store is `research/.data/store.json`, and tasks run on in-process threads.

**OpenBCI checklist.** Confirm the board (Cyton, Cyton+Daisy or Ganglion) and the serial port with
`ls /dev/cu.usbserial*`. Close the OpenBCI GUI, because only one program can hold the port. Mains is
60 Hz in the US (`--mains 50` elsewhere). Use `--channels` if your electrode order differs from
`Fp1,Fp2,C3,C4,P7,P8,O1,O2`. Eyes-closed alpha appears on O1/O2 within a few seconds, and blinks show on Fp1/Fp2.
To use a recording for inverse modelling, start the bridge with `--cloud`, set `CORTEX_API` and
`CORTEX_INGEST_TOKEN` (a device token from the lab sidebar), and use `--record 30 --label "eyes closed"`,
or trigger the recording from the lab UI.

## Deploy (GCP)

Everything is in `research/deploy/deploy.sh` and configured from `research/.env`. The script is
idempotent and provisions:
- Firestore (native);
- Artifact Registry;
- Cloud Tasks queue `cortex2-work`;
- GCS artifact bucket;
- service accounts `cortex2-api` and `cortex2-tasks` with least-privilege roles;
- Secret Manager secrets for the model keys (`GEMINI_API_KEY`, `GEMINI_API_KEY_B`, `GEMINI_API_KEY_C`, `OPENAI_API_KEY`) and `IBM_QUANTUM_TOKEN`;
- a Cloud Build image;
- Cloud Run `cortex2`, public, serving the API and the lab, with min-instances 1;
- Cloud Run `cortex2-worker`, private, invoked only by Cloud Tasks and Scheduler OIDC;
- a Cloud Scheduler heartbeat.

```bash
gcloud auth login && gcloud auth application-default login   # as the project owner
research/deploy/deploy.sh                                     # build + deploy (~10 min)
SKIP_BUILD=1 research/deploy/deploy.sh                        # config/secrets only
```

Manual one-time steps:
1. **OAuth client.** In APIs & Services → Credentials → OAuth client ID (Web), add the
   authorized JavaScript origins `https://cortex2-<project-number>.us-central1.run.app` and
   `http://127.0.0.1:5173`. Put the ID in `GOOGLE_OAUTH_CLIENT_ID` and redeploy, because the ID is baked
   into the web build. You can restrict access with `ALLOWED_EMAILS`.
2. **Keys.** Set the model keys named in `AGENT_PROVIDERS` and `IBM_QUANTUM_TOKEN` (optionally `IBM_QUANTUM_INSTANCE` and `IBM_BACKEND`)
   in `research/.env`, then redeploy. Secrets go to Secret Manager and never reach the browser.
3. **IBM time.** The Open plan provides about 10 QPU-minutes per 28 days. Submit hardware jobs before
   the demo, because results and job IDs persist and the live submission is a bonus.

## Demo script (3 minutes)

1. **The brain.** The headset is on. Blinks make the brain blink. Eyes closed lights up occipital
   alpha on the fibers, and hovering shows the numbers. Point out that the fibers are an
   illustrative overlay, not tractography.
2. **The problem.** Open the synthetic `10101011` (alpha rhythm) experiment. The landscape shows 256 hypotheses.
   The naive in-budget QAOA lands far from the optimum, with loss ≈3.1 against a minimum of 0.09.
3. **The engineer.** Press *Run iteration*. Then walk through the tool trace, the custom QASM it wrote,
   the gate count against the 130 budget, the image it looked at, and the measured verdict.
4. **Hardware.** Show the pre-submitted IBM job: job ID, backend, shots, physical gates, and the TVD
   against the ideal simulation. Compare it with the THRML and annealing samplers on the same Ising model.
5. **Seizure.** Show the CHB-MIT pre-ictal and ictal experiments side by side. The model explains the
   seizure segment with higher drive and slower dynamics. Repeat that this is a hypothesis
   about a simplified model, not a cause.
6. **Rigor.** Show `research/experiments/BENCHMARK.md` and the reproducible export JSON.
