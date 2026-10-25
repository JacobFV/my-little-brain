/** Typed client for the cortex² research service (docs/cortex2-api.md). */

export type ProviderId =
  | 'classical_exact'
  | 'classical_anneal'
  | 'random'
  | 'aer_ideal'
  | 'aer_noisy'
  | 'thrml'
  | 'ibm_quantum'
  | 'ionq_simulator'
  | 'ionq_qpu';
export type Approximation =
  'surrogate' | 'secant' | 'jacobian' | 'regression' | 'feature_regression' | 'trust_region';
export const HARDWARE_PROVIDERS: ReadonlySet<string> = new Set(['ibm_quantum', 'ionq_qpu']);
export type JobStatus = 'queued' | 'running' | 'submitted' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'sample' | 'agent_iteration' | 'agent_operator';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: string;
  available: boolean;
  reason?: string | null;
}
export interface LabConfig {
  auth: { google_client_id: string; dev_auth: boolean };
  model: string;
  agent_configured: boolean;
  gate_budget: number;
  offline_target: string;
  providers: ProviderInfo[];
  param_names: string[];
  param_levels: number[][];
  feature_names: string[];
}
export interface Me {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
}
export interface Session {
  autopilot: boolean;
  max_autonomous_jobs: number;
  autonomous_jobs_total: number;
  allow_autonomous_qpu: boolean;
  qpu_jobs_budget: number;
  qpu_jobs_total: number;
  operator_memory?: string;
  last_tick?: string;
}
export interface Dataset {
  id: string;
  label: string;
  kind: string;
  fs: number;
  channels: string[];
  segments: string[];
}
export interface SyntheticPreset {
  bitstring: string;
  label: string;
}
export interface Target {
  source: 'synthetic' | 'recording' | 'openbci';
  label: string;
  features: number[];
  weights: number[];
  feature_names: string[];
  truth_bitstring: string | null;
  truth_params: Record<string, number> | null;
  meta: Record<string, unknown>;
}
export interface Best {
  bitstring: string;
  nonlinear_loss: number;
  parameters: Record<string, number>;
  job_id?: string;
  consistent?: boolean;
}
export interface Experiment {
  id: string;
  title: string;
  owner?: string;
  created_at: string;
  updated_at?: string;
  target: Target;
  observed_trace?: { fs: number; samples: number[] };
  best: Best | null;
  baseline?: string;
  rounds?: number;
  status?: string;
}
export interface Landscape {
  states: string[];
  levels: number[][];
  nonlinear_loss: number[];
  qubo_energy?: number[] | null;
  consistency_threshold: number;
  param_names: string[];
  param_levels: number[][];
}
export interface CircuitSpec {
  reps?: number;
  gammas?: number[] | null;
  betas?: number[] | null;
  prune_threshold?: number;
  max_couplings?: number | null;
  warm_start?: string | null;
  warm_epsilon?: number;
  coupling_order?: string;
  optimization_level?: number;
  seed_transpiler?: number;
}
export interface CircuitOp {
  gate: string;
  qubits: number[];
  params?: number[];
}
export interface Circuit {
  qubits: number;
  operations: CircuitOp[];
  truncated?: boolean;
  size?: number;
  gates?: number;
  depth?: number;
  two_qubit_gates?: number;
  two_qubit_depth?: number;
  ops?: Record<string, number>;
}
export interface Transpiled {
  backend: string;
  size?: number;
  gates: number;
  depth: number;
  two_qubit_gates: number;
  two_qubit_depth: number;
  physical_qubits?: number[];
  within_budget: boolean;
  budget: number;
}
export interface QuboQuality {
  qubo_argmin: string;
  qubo_argmin_nonlinear_loss: number;
  nonlinear_argmin: string;
  nonlinear_min_loss: number;
  rank_of_nonlinear_argmin_under_qubo: number;
  spearman: number;
}
export interface Candidate {
  bitstring: string;
  samples: number;
  probability: number;
  nonlinear_loss: number;
  nonlinear_rank: number;
  qubo_energy: number | null;
  consistent: boolean;
  validated?: boolean;
  levels: number[];
  parameters: Record<string, number>;
}
export interface Evaluation {
  shots: number;
  distinct_states: number;
  validation_budget: number;
  best: Candidate;
  best_any_sample?: Candidate;
  validated: Candidate[];
  candidates: Candidate[];
  best_nonlinear_loss: number;
  best_consistent: boolean;
  expected_nonlinear_loss: number;
  uniform_expected_loss: number;
  min_possible_loss: number;
  approximation_ratio: number;
  p_consistent: number;
  p_top8: number;
  consistent_set_size: number;
  uniform_p_consistent: number;
  truth?: {
    bitstring: string;
    p_truth: number;
    uniform_p_truth: number;
    recovered_exactly: boolean;
    truth_in_consistent_set: boolean;
    best_hamming_distance: number;
    parameter_level_error: Record<string, number>;
    truth_nonlinear_rank: number;
  };
}
export interface Job {
  id: string;
  experiment_id?: string;
  owner?: string;
  kind: JobKind;
  provider?: ProviderId | string | null;
  status: JobStatus;
  created_at: string;
  updated_at?: string;
  created_by?: 'user' | 'agent';
  autonomous?: boolean;
  title?: string;
  approximation?: Approximation;
  baseline?: string;
  trust_weight?: number;
  spec?: CircuitSpec;
  qasm_source?: string;
  qubo_quality?: QuboQuality;
  circuit?: Circuit;
  transpiled?: Transpiled;
  isa_circuit?: Circuit;
  provider_job_id?: string | null;
  backend?: string | null;
  provider_status?: string | null;
  quantum_seconds?: number | null;
  counts?: Record<string, number>;
  ideal_tvd?: number | null;
  evaluation?: Evaluation;
  runner?: Record<string, unknown>;
  revision_id?: string | null;
  error?: string | null;
  timings?: { queued?: string; started?: string; finished?: string };
  result?: Record<string, unknown>;
}
export interface Revision {
  id: string;
  experiment_id: string;
  number: number;
  created_at: string;
  model?: string;
  response_ids?: string[];
  observation?: string;
  diagnosis?: string;
  change?: string;
  rationale?: string;
  spec_before?: CircuitSpec | null;
  spec_after?: CircuitSpec | null;
  approximation_before?: string | null;
  approximation_after?: string | null;
  qasm_diff?: string | null;
  job_ids?: string[];
  metric?: string;
  metric_before?: number | null;
  metric_after?: number | null;
  secondary?: Record<string, number | null>;
  verdict: 'improved' | 'regressed' | 'unchanged' | 'untested';
  image?: string | null;
  tool_trace?: Array<{ tool: string; args?: unknown; summary?: string }>;
}
export interface FeedItem {
  id: string;
  kind: 'user' | 'agent' | 'result' | 'system' | 'error';
  text: string;
  experiment_id?: string | null;
  job_id?: string | null;
  time: string;
  data?: Record<string, unknown>;
}
export interface ExperimentDetail {
  experiment: Experiment;
  landscape: Landscape;
  jobs: Job[];
  revisions: Revision[];
}
export interface Preview {
  qubo_quality: QuboQuality;
  ising: { h: number[]; J: number[][]; offset: number };
  spec: CircuitSpec;
  circuit: Circuit;
  transpiled: Transpiled;
  ideal: {
    expected_nonlinear_loss: number;
    p_consistent: number;
    p_truth?: number | null;
    top: Array<{ bitstring: string; p: number }>;
  };
}
export interface EEGFrame {
  board?: string;
  fs: number;
  channel_names: string[];
  samples: number[][];
  bands?: Partial<Record<Band, number>>;
  per_channel_bands?: Array<Partial<Record<Band, number>>>;
  blink?: boolean;
  /** v1: one string; bridge protocol v2: one label per channel (ok|railed|flat|noisy|no data). */
  quality?: string | string[];
  t?: number;
  // ---- bridge protocol v2 (additive)
  state?: string;
  blink_count?: number;
  alpha_state?: AlphaState;
  alpha_fraction?: number;
  alpha_baseline?: number;
  /** Mains power ÷ 1–45 Hz power per channel (raw signal). */
  line_noise?: number[];
  recording?: { label: string; seconds: number; elapsed: number } | null;
}
export type AlphaState = 'eyes_open' | 'eyes_closed' | 'unknown';
/** Normalise v1/v2 quality to one label per channel. */
export function channelQuality(frame: Pick<EEGFrame, 'quality' | 'channel_names'>): string[] {
  const q = frame.quality;
  const labels = Array.isArray(q) ? q : q && q.includes(',') ? q.split(',') : null; // cloud: "ok,ok,flat,…"
  if (labels) return frame.channel_names.map((_, i) => labels[i] ?? 'unverified');
  return frame.channel_names.map(() => (typeof q === 'string' && q) || 'unverified');
}
export const BAD_QUALITY = new Set(['railed', 'flat', 'no data', 'railed/noisy']);
export type Band = 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma';
export const BANDS: Band[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
export interface Recording {
  id: string;
  label: string;
  fs: number;
  channel_names: string[];
  seconds: number;
  created_at: string;
}
export interface JobRequest {
  provider: ProviderId;
  approximation?: Approximation;
  baseline?: string | null;
  trust_weight?: number;
  spec?: CircuitSpec;
  qasm?: string | null;
  shots?: number;
}
export type NewExperiment =
  | { source: 'synthetic'; truth_bitstring?: string; random_seed?: number; title?: string }
  | { source: 'recording'; dataset_id: string; channel: string; segment: string; title?: string }
  | { source: 'openbci'; recording_id: string; channel?: string; title?: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const ENV_BASE = (import.meta.env.VITE_CORTEX_API || '').replace(/\/$/, '');
export const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled'];
export const isActive = (j: Pick<Job, 'status'>) => !TERMINAL.includes(j.status);

/** Pull a human message out of a FastAPI style error body. */
export function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail))
      return detail
        .map((d) =>
          d && typeof d === 'object' && 'msg' in d
            ? String((d as { msg: unknown }).msg)
            : String(d),
        )
        .join('; ');
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  if (status === 401) return 'Your sign-in expired. Sign in again.';
  if (status === 429) return 'Too many requests — please wait a moment and try again.';
  if (status === 0) return 'The research service is unreachable.';
  return `Request failed (HTTP ${status}).`;
}

export class CortexClient {
  constructor(
    public token: string | null,
    public base = ENV_BASE,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { ...init, headers });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError(0, errorMessage(0, null));
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get('Retry-After'));
      throw new ApiError(
        429,
        `Easy there — the lab is rate-limiting requests. Try again in ${
          Number.isFinite(wait) && wait > 0 ? `${Math.ceil(wait)} s` : 'a moment'
        }.`,
      );
    }
    if (!response.ok) throw new ApiError(response.status, errorMessage(response.status, body));
    return body as T;
  }
  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { signal });
  }
  post<T>(path: string, data: unknown = {}) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(data) });
  }

  config = () => this.get<LabConfig>('/v1/config');
  me = () => this.get<Me>('/v1/me');
  session = () => this.get<Session>('/v1/session');
  updateSession = (patch: Partial<Session>) => this.post<Session>('/v1/session', patch);
  datasets = () =>
    this.get<{ datasets: Dataset[]; synthetic_presets: SyntheticPreset[] }>('/v1/datasets');
  experiments = () => this.get<{ experiments: Experiment[] }>('/v1/experiments');
  experiment = (id: string, signal?: AbortSignal) =>
    this.get<ExperimentDetail>(`/v1/experiments/${encodeURIComponent(id)}`, signal);
  createExperiment = (body: NewExperiment) =>
    this.post<{ experiment: Experiment }>('/v1/experiments', body);
  createJob = (experimentId: string, body: JobRequest) =>
    this.post<{ job: Job }>(`/v1/experiments/${encodeURIComponent(experimentId)}/jobs`, body);
  preview = (experimentId: string, body: JobRequest) =>
    this.post<Preview>('/v1/circuits/preview', { ...body, experiment_id: experimentId });
  jobs = (experimentId?: string) =>
    this.get<{ jobs: Job[] }>(
      `/v1/jobs${experimentId ? `?experiment_id=${encodeURIComponent(experimentId)}` : ''}`,
    );
  job = (id: string) => this.get<{ job: Job }>(`/v1/jobs/${encodeURIComponent(id)}`);
  cancelJob = (id: string) => this.post<{ job: Job }>(`/v1/jobs/${encodeURIComponent(id)}/cancel`);
  iterate = (experimentId: string, instruction?: string) =>
    this.post<{ job: Job }>(`/v1/experiments/${encodeURIComponent(experimentId)}/agent/iterate`, {
      instruction,
    });
  message = (text: string, experimentId?: string | null) =>
    this.post<{ item: FeedItem; job: Job }>('/v1/agent/messages', {
      text,
      experiment_id: experimentId || undefined,
    });
  feed = (experimentId?: string | null) =>
    this.get<{ items: FeedItem[] }>(
      `/v1/feed${experimentId ? `?experiment_id=${encodeURIComponent(experimentId)}` : ''}`,
    );
  hypothesisTrace = (bitstring: string, seconds = 2) =>
    this.get<{
      fs: number;
      samples: number[];
      parameters: Record<string, number>;
      bands: Record<string, number>;
    }>(`/v1/hypotheses/${encodeURIComponent(bitstring)}/trace?seconds=${seconds}`);
  snapshot = (experimentId: string, png: string) =>
    this.post(`/v1/experiments/${encodeURIComponent(experimentId)}/snapshot`, { png });
  ingestToken = () =>
    this.post<{ token: string; expires_in_seconds: number }>('/v1/eeg/ingest-token');
  eegLatest = (signal?: AbortSignal) =>
    this.get<{ live: boolean; frame: EEGFrame | null }>('/v1/eeg/latest', signal);
  recordings = () => this.get<{ recordings: Recording[] }>('/v1/eeg/recordings');
  exportUrl = (experimentId: string) =>
    `${this.base}/v1/experiments/${encodeURIComponent(experimentId)}/export`;

  /** Authenticated GET of an image endpoint → object URL. Caller revokes. */
  async imageUrl(pathAndQuery: string): Promise<string> {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const r = await this.fetcher(`${this.base}${pathAndQuery}`, { headers });
    if (!r.ok)
      throw new ApiError(r.status, errorMessage(r.status, await r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }).catch(() => null)));
    return URL.createObjectURL(await r.blob());
  }
  /** Authenticated artifact (PNG) → object URL. Caller revokes. */
  artifact(path: string): Promise<string> {
    const clean = path.replace(/^\/+/, '').replace(/^v1\/artifacts\//, '');
    return this.imageUrl(`/v1/artifacts/${clean.split('/').map(encodeURIComponent).join('/')}`);
  }
  /** Per-channel spectrogram grid (the image the agent triages). */
  spectrogram(src: { dataset_id?: string; recording_id?: string; start?: number; end?: number; channels?: string[] }) {
    const q = new URLSearchParams();
    if (src.dataset_id) q.set('dataset_id', src.dataset_id);
    if (src.recording_id) q.set('recording_id', src.recording_id);
    if (src.start != null) q.set('start', String(src.start));
    if (src.end != null) q.set('end', String(src.end));
    if (src.channels?.length) q.set('channels', src.channels.join(','));
    return this.imageUrl(`/v1/eeg/spectrogram?${q}`);
  }
  triage = (body: { dataset_id?: string; recording_id?: string; start?: number; end?: number; instruction?: string }) =>
    this.post<{ item: FeedItem; job: Job }>('/v1/eeg/triage', body);
  async download(experimentId: string): Promise<Blob> {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const r = await this.fetcher(this.exportUrl(experimentId), { headers });
    if (!r.ok)
      throw new ApiError(r.status, errorMessage(r.status, await r.text().catch(() => null)));
    return r.blob();
  }
}

export const PROVIDER_LABEL: Record<string, string> = {
  classical_exact: 'Exact enumeration',
  classical_anneal: 'Simulated annealing',
  random: 'Random baseline',
  aer_ideal: 'Aer ideal simulator',
  aer_noisy: 'Aer noisy simulator',
  thrml: 'Extropic THRML (software)',
  ibm_quantum: 'IBM Quantum QPU',
  ionq_simulator: 'IonQ simulator (trapped-ion noise)',
  ionq_qpu: 'IonQ trapped-ion QPU',
  agent: 'Research agent',
};

/** Provenance line for any chart showing provider results. */
export function provenance(
  job: Pick<Job, 'provider' | 'backend' | 'status' | 'kind'> | null | undefined,
): string {
  if (!job) return 'illustrative';
  const p = job.provider ?? '';
  if (p === 'ibm_quantum')
    return `IBM ${job.backend || 'quantum'} · ${job.status === 'completed' ? 'measured' : job.status}`;
  if (p === 'ionq_qpu')
    return `IonQ ${job.backend || 'QPU'} · ${job.status === 'completed' ? 'measured' : job.status}`;
  if (p === 'ionq_simulator') return `IonQ cloud simulator${job.backend ? ` · ${job.backend}` : ''} · simulated`;
  if (p === 'aer_noisy') return 'Aer noisy simulator · simulated';
  if (p === 'aer_ideal') return 'Aer ideal simulator · simulated';
  if (p === 'thrml') return 'THRML (software) · simulated thermodynamic sampling';
  if (p === 'classical_anneal') return 'Simulated annealing · classical';
  if (p === 'classical_exact') return 'Exact enumeration · classical';
  if (p === 'random') return 'Uniform random · baseline';
  return PROVIDER_LABEL[p] || p || 'job';
}

export function elapsed(from?: string, to?: string): string {
  if (!from) return '';
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const fmt = (v: number | null | undefined, digits = 3) =>
  v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(digits);
export const pct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
