# cortex² API contract (research service ↔ `/lab`)

Base URL: `VITE_CORTEX_API` (same origin in production, so usually empty).
All `/v1/*` routes except `/v1/config` and the device-token EEG routes need
`Authorization: Bearer <google id token>`. Locally, with `DEV_AUTH=1` and not on
Cloud Run, `Bearer dev` is accepted as the user `dev@localhost`.

Errors: non-2xx with `{"detail": "human readable"}`. Nothing is ever faked: a
missing credential returns 503 with a message naming the missing setting.

## Enumerations

provider: `classical_exact | classical_anneal | random | aer_ideal | aer_noisy | thrml | ibm_quantum | qbraid_simulator | qbraid_qpu`

approximation: `secant | jacobian | regression | feature_regression | trust_region`

job.status: `queued | running | submitted | completed | failed | cancelled`
(`submitted` = waiting on IBM queue; the worker polls it)

job.kind: `sample | agent_iteration | agent_operator`

## Config / identity

`GET /v1/config` (public)
```json
{ "auth": {"google_client_id": "…", "dev_auth": false},
  "model": "gemini-4-argon", "agent_configured": true,
  "model_providers": [{"provider":"gemini/gemini-4-argon (GEMINI_API_KEY)","family":"gemini","model":"gemini-4-argon","configured":true,"cooling_down":null}],
  "gate_budget": 130, "offline_target": "fake_torino",
  "providers": [{"id":"ibm_quantum","label":"IBM Quantum (QPU)","kind":"quantum","available":false,"reason":"IBM_QUANTUM_TOKEN not set"}],
  "param_names": ["excitatory_drive","inhibitory_gain","recurrent_excitation","synaptic_tau_ms"],
  "param_levels": [[1.5,2,2.5,3],[10,13,16,19],[12,14,16,18],[5,8,12,17]],
  "feature_names": ["rel_logpow_1.0-1.5Hz", "…", "log_amplitude"] }
```
`GET /v1/me` → `{uid,email,name,picture}`

`GET /v1/session` / `POST /v1/session` (partial update)
```json
{ "autopilot": false, "max_autonomous_jobs": 12, "autonomous_jobs_total": 0,
  "allow_autonomous_qpu": false, "qpu_jobs_budget": 2, "qpu_jobs_total": 0,
  "operator_memory": "rolling summary the agent keeps across ticks", "last_tick": "iso" }
```

## Datasets and experiments

`GET /v1/datasets` → `{ "datasets": [{ "id":"chbmit-chb01_03", "label":"CHB-MIT chb01_03 (seizure 2996–3036 s)",
  "kind":"recording", "fs":256, "channels":["FP1-F7",…], "segments":["preictal","ictal"] }],
  "synthetic_presets": [{"bitstring":"01110100","label":"…"}] }`

`POST /v1/experiments`
```json
{ "source": "synthetic", "truth_bitstring": "01110100" }        // or "random_seed": 3
{ "source": "recording", "dataset_id": "chbmit-chb01_03", "channel": "FP1-F7", "segment": "ictal" }
{ "source": "openbci", "recording_id": "…" }                      // uploaded by the bridge
```
→ `{ "experiment": Experiment }`

`GET /v1/experiments` → `{ "experiments": [Experiment] }` (newest first)

`GET /v1/experiments/{id}` →
```json
{ "experiment": Experiment, "landscape": Landscape, "jobs": [Job], "revisions": [Revision] }
```
`GET /v1/experiments/{id}/export` → full reproducible JSON (same + code version + seeds).

Experiment:
```json
{ "id","title","owner","created_at","updated_at",
  "target": { "source","label","features":[11],"weights":[11],"feature_names":[11],
              "truth_bitstring": "01110100" | null, "truth_params": {…} | null, "meta": {} },
  "observed_trace": {"fs": 2000, "samples": [≤1000 z-scored]},
  "best": { "bitstring","nonlinear_loss","parameters":{…},"job_id","consistent" } | null,
  "baseline": "00000000",            // current linearisation point (best validated so far)
  "rounds": 3, "status": "idle|running" }
```
Landscape (all 256 hypotheses, index = integer state, bit i = qubit i):
```json
{ "states": ["00000000",…], "levels": [[0,0,0,0],…], "nonlinear_loss": [256],
  "consistency_threshold": 0.71, "param_names": […], "param_levels": […] }
```

## Jobs

`POST /v1/experiments/{id}/jobs`
```json
{ "provider": "aer_noisy", "approximation": "trust_region", "baseline": "01110000",
  "trust_weight": 0.15, "spec": CircuitSpec, "qasm": "OPENQASM 2.0; …" | null, "shots": 1024 }
```
→ `{ "job": Job }`. `qasm` overrides `spec` (gate-model providers only).

`POST /v1/circuits/preview` (synchronous, < 5 s) same body + `experiment_id` →
```json
{ "qubo_quality": QuboQuality, "ising": {"h":[8],"J":[[8x8]],"offset":0},
  "spec": CircuitSpec, "circuit": Circuit, "transpiled": Transpiled,
  "ideal": { "expected_nonlinear_loss", "p_consistent", "p_truth", "top": [{"bitstring","p"}] } }
```
`GET /v1/jobs?experiment_id=…` → `{ "jobs": [Job] }` (owner's, newest first, ≤100)
`GET /v1/jobs/{id}` → `{ "job": Job }`;  `POST /v1/jobs/{id}/cancel`

CircuitSpec: `{ reps, gammas|null, betas|null, prune_threshold, max_couplings|null, warm_start|null, warm_epsilon, coupling_order, optimization_level, seed_transpiler }`

Circuit (`describe`): `{ qubits: 8, operations: [{gate, qubits:[i,j], params:[…]}], truncated, size, gates, depth, two_qubit_gates, two_qubit_depth, ops: {name: n} }`

Transpiled: `{ backend, size, gates, depth, two_qubit_gates, two_qubit_depth, physical_qubits:[8], within_budget, budget }`

QuboQuality: `{ qubo_argmin, qubo_argmin_nonlinear_loss, nonlinear_argmin, nonlinear_min_loss, rank_of_nonlinear_argmin_under_qubo, spearman }`

Job:
```json
{ "id","experiment_id","owner","kind","provider","status","created_at","updated_at",
  "created_by": "user|agent", "autonomous": false, "title",
  "approximation","baseline","trust_weight","spec","qasm_source": "spec|agent_qasm",
  "qubo_quality", "circuit", "transpiled", "isa_circuit",
  "provider_job_id","backend","provider_status","quantum_seconds",
  "counts": {"01110100": 37, …}, "ideal_tvd": 0.12,
  "evaluation": Evaluation, "runner": {"mode": "aer_noisy", …},
  "revision_id": null, "error": null, "timings": {"queued","started","finished"} }
```
Evaluation (`inverse.evaluate_counts`): `{ shots, distinct_states, validation_budget, best, best_any_sample,
validated:[Cand], candidates:[Cand], best_nonlinear_loss, best_consistent, expected_nonlinear_loss,
uniform_expected_loss, min_possible_loss, approximation_ratio, p_consistent, p_top8,
consistent_set_size, uniform_p_consistent, truth?: { bitstring, p_truth, uniform_p_truth,
recovered_exactly, truth_in_consistent_set, best_hamming_distance, parameter_level_error, truth_nonlinear_rank } }`

Cand: `{ bitstring, samples, probability, nonlinear_loss, nonlinear_rank, qubo_energy, consistent, validated?, levels, parameters }`

`GET /v1/hypotheses/{bitstring}/trace?seconds=2` → `{ "fs": 2000, "samples": [z-scored] , "parameters": {…}, "bands": {delta,…} }`

## Agent

`POST /v1/experiments/{id}/agent/iterate` `{ "instruction": "optional" }` → `{ job }` (kind agent_iteration).
One iteration = the model inspects state, builds/compiles circuits with tools, runs them,
looks at the rendered comparison image, and records one Revision. Verdicts are computed
from measured metrics, never from the model's claim.

`GET /v1/experiments/{id}/revisions` → `{ revisions: [Revision] }`

Revision:
```json
{ "id","experiment_id","number","created_at","model","response_ids":[…],
  "observation","diagnosis","change","rationale",
  "spec_before","spec_after","approximation_before","approximation_after",
  "qasm_diff": "unified diff or null", "job_ids": […],
  "metric": "best_nonlinear_loss", "metric_before": 0.67, "metric_after": 0.27,
  "secondary": {"physical_gates_before":424,"physical_gates_after":105,"p_consistent_before":…,"p_consistent_after":…},
  "verdict": "improved|regressed|unchanged|untested",
  "image": "artifact path or null", "tool_trace": [{"tool","args","summary"}] }
```

`POST /v1/agent/messages` `{ "text", "experiment_id"?: "…" }` → `{ item: FeedItem, job }` – the long-running
operator: reads all experiments/jobs, can dispatch/cancel/retry/poll jobs within session budgets,
start design iterations, and replies into the feed.

`GET /v1/feed?experiment_id=` → `{ items: [FeedItem] }` newest first
FeedItem: `{ id, kind: "user|agent|result|system|error", text, experiment_id, job_id, time, data? }`

## Artifacts and snapshots
`GET /v1/artifacts/{path}` → image/png (owner-scoped path). Revision images and job renders.
`POST /v1/experiments/{id}/snapshot` `{ "png": "data:image/png;base64,…" }` – latest 3D brain
view; the agent receives it with the numeric comparison.

## EEG
`POST /v1/eeg/ingest-token` → `{ token, expires_in_seconds }` (paste into the local bridge)
`POST /v1/eeg/ingest` (Bearer device token) – 2 Hz summary frame:
`{ board, fs, channel_names:[…], samples:[[≤256] per channel], bands:{delta,theta,alpha,beta,gamma}, per_channel_bands:[{…}], blink: bool, quality: "…" }`
`GET /v1/eeg/latest` → `{ live: bool, frame: Frame|null }`
`POST /v1/eeg/recordings` (Bearer device token) `{ label, fs, channel_names, data: [[float] per channel] (≤60 s) }` → `{ recording_id }`
`GET /v1/eeg/recordings` → `{ recordings: [{id,label,fs,channel_names,seconds,created_at}] }`

Local bridge WebSocket (lowest latency, same machine as the headset): `ws://127.0.0.1:8765`
messages at ~20 Hz: `{ "type":"frame", "t": 1730000000.1, "board":"cyton", "fs":250,
"channel_names":[…], "samples":[[new samples per channel]], "bands":{delta,theta,alpha,beta,gamma},
"per_channel_bands":[{…}], "blink": false, "quality": "ok|railed|flat" }`

### Bridge protocol v2 (additive; `hello.protocol == 2`)

Frames gain:
```json
{ "state": "streaming", "blink_count": 12,
  "alpha_state": "eyes_open | eyes_closed | unknown", "alpha_fraction": 0.31, "alpha_baseline": 0.19,
  "quality": ["ok","railed","flat","noisy","no data", …],     // one per channel (was a single string in v1 docs)
  "line_noise": [0.02, …],                                     // mains power ÷ 1–45 Hz power per channel (raw signal)
  "per_channel_bands": [{"delta","theta","alpha","beta","gamma","rms_uv"}, …],
  "recording": null | { "label", "seconds", "elapsed" } }
```
`hello` gains `state`, `message`, `serial_port`, `protocol: 2`.

New server → browser messages:
- `{ "type":"status", "state":"connecting|streaming|reconnecting|stopped", "message", "board", "serial_port" }`
- `{ "type":"recording_progress", "label", "seconds", "elapsed" }`, about once per second while recording
- `{ "type":"recording", "recording_id": "…" | null, "path": "local json", "message" }`. `recording_id` is null when
  cloud upload is not configured.
- `{ "type":"error", "message" }`

Browser → bridge messages:
- `{ "type":"record", "seconds": 4–60, "label" }`
- `{ "type":"ping" }`, answered by `{ "type":"pong", "t" }`

Suggested UI use:
- `alpha_state === "eyes_closed"` → sleepy mood with occipital fibres glowing;
- `blink` → force a blink;
- `status.state === "reconnecting"` → show `message` as a banner;
- quality `railed`/`flat` → dim that anchor.

