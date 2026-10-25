# cortex²: hackathon research lab

This is a **new hackathon feature** on `hackathon/cortex2-research-lab`, deliberately
separate from the existing My Little Brain product. Do **not** merge into main
until reviewed. The existing anatomical renderer, eye animation, and workspace
design predate the hackathon; new contributions are `/lab`, the propagation
overlay, research service, experiment adapters, and EEG bridge.

## Product
- `/lab`: my-little-brain three-pane research workspace. Left: sources, sessions,
  experiment/job history. Center: real brain meshes, blinking eyes, stylized
  translucent fiber propagation, oscillograms, quantum gates and measured bitstrings.
  Right: analyses, bandpowers, selected job outputs, and an agent-command composer.
- UI explicitly labels synthetic/illustrative activity. An 8-channel schematic
  **cannot** justify tractography, neural source attribution, epilepsy diagnosis,
  or localization from scalp EEG. Anatomical fibers are visual illustration.
- The backend uses durable Firestore jobs and Cloud Tasks instead of browser timers.
  IBM QPU jobs are submitted then polled by separately scheduled worker requests.
- The same binary energy objective is evaluated by exact enumeration, Qiskit
  (simulator or physical IBM machine), and Extropic's **THRML software** Gibbs
  sampler. THRML is not physical Extropic hardware and does not run quantum circuits.
  Real Extropic hardware needs a separate vendor adapter and access credentials.

## Repo changes
- `apps/web/src/research/ResearchLab.tsx`: UX, account sign-in, live readout,
  compute dispatch and agent job list.
- `packages/brain/src/index.tsx`: research-only 3d signal pathways, beads,
  and animated pulses, preserving the original renderer and its blink behavior.
- `research/backend/solver.py`: deterministic synthetic inverse-model benchmark,
  QUBO/Ising-style circuit, classical and thermodynamic samplers.
- `research/backend/api.py`: OAuth ID token verification, Firestore records,
  Cloud Tasks worker, long-lived IBM polling, model-based research summaries.
- `research/bridge/openbci.py`: local EEG capture and HTTPS ingestion.

## quickstart
Run the original monorepo and visit `http://127.0.0.1:5173/lab`.
The visual preview needs no cloud account; simulated EEG and illustrative
qubit schematic are **not real provider results**.

To run the API locally, configure Application Default Credentials and Firestore:
```bash
cd research/backend
pip install -r requirements.txt
export GOOGLE_CLOUD_PROJECT=<project>
export GOOGLE_OAUTH_CLIENT_ID=<web-oauth-client-id>
export CORS_ORIGINS=http://127.0.0.1:5173
uvicorn api:app --reload --port 8080
```
Run web with build-time `VITE_CORTEX_API=http://127.0.0.1:8080` and
`VITE_GOOGLE_CLIENT_ID=<web-oauth-client-id>`. Google OAuth requires adding
the actual website origin to the authorized JavaScript origins. The existing
Express server must permit the Google Identity script only on `/lab`.

For actual jobs, provision Cloud Tasks with a worker request URL, a service
account authorized to create tasks, and a request-identity account:
`TASK_QUEUE`, `TASK_REGION`, `TASK_SERVICE_ACCOUNT`, `WORKER_URL`.
Set `GOOGLE_CLOUD_PROJECT` on both containers. For IBM, set
`IBM_QUANTUM_TOKEN` using Secret Manager and select a current supported backend.
For the agent, use `OPENAI_API_KEY` and a verified API-model identifier in
`GPT_MODEL`. **Never** put either key in Vite build variables.

For optional Extropic software sampling:
```bash
pip install thrml jax jaxlib
```
No physical Extropic device is assumed or claimed.

For the EEG bridge, obtain an authenticated short-lived ingest credential:
```bash
curl -X POST "$CORTEX_API/v1/eeg/ingest-token" \
  -H "Authorization: Bearer <google-id-token>"
cd research/bridge
pip install -r requirements.txt
CORTEX_API=https://<api-url> CORTEX_INGEST_TOKEN=<one-time-token> \
  python openbci.py --board synthetic
# Real OpenBCI Cyton with USB serial:
python openbci.py --board cyton --serial-port /dev/tty.usbserial-XXXX
```
The bridge runs locally because Google Cloud Run cannot access your USB/Bluetooth
OpenBCI device directly. Do not route raw EEG through unauthenticated endpoints.

## deploy architecture (all application infrastructure on gcp)
1. Enable Cloud Run, Cloud Build, Firestore Native mode, Cloud Tasks,
   Secret Manager, Cloud Logging, and Identity APIs.
2. Configure Google OAuth web client and restricted callback origins.
3. Build and deploy the FastAPI container from `research/backend/Dockerfile`.
   Use a dedicated service identity with least-privilege Firestore and Cloud Tasks
   roles, and Secret Manager keys for vendor credentials.
4. Create a Cloud Tasks queue in the same region. Configure OIDC-authenticated
   dispatch to `/internal/execute`, with an appropriately scoped service account.
   Internal jobs verify the worker service identity.
5. Build the original web application with Vite environment variables and deploy
   its existing static/Express server to Cloud Run. If using the existing Node
   server, set `HOST=0.0.0.0`, `PORT=8080`, a strong
   `APP_ACCESS_TOKEN` and matching `ALLOWED_ORIGINS` for the original app.
6. Enable Cloud Logging / Error Reporting and define budgets and quota limits
   before enabling paid IBM jobs. Persist circuit parameters and job ids for
   reproducibility; do not claim quantum advantage from an 8-bit benchmark.

## what is implemented vs not yet validated
Implemented **in source**: research UX route, stylized 3d propagation, measured
EEG ingest API and bridge, Google Identity hook, Cloud Tasks/Firestore job service,
Qiskit/THRML/classical solver adapters, IBM polling, agent job request handling.

Not yet shown in a running deployment: successful build/typecheck,
Google-authenticated sign-in, hardware OpenBCI acquisition, cloud configuration,
THRML sampling on installed JAX versions, physical IBM provider execution,
or an authenticated model response. No hardware job IDs are fabricated.

## judge provenance
In the demo, explicitly identify the previous renderer/companion and show the
hackathon feature branch + diff. Separate synthetic overlays from measured values.
Evaluate recovered synthetic ground truth, nonlinear residual, gate counts,
provider samples, and variance across repeated physical quantum trials.
