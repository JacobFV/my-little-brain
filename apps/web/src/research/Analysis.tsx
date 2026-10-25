import { useEffect, useMemo, useState } from 'react';
import { Download, Eye, Play } from 'lucide-react';
import {
  fmt,
  isActive,
  pct,
  PROVIDER_LABEL,
  provenance,
  HARDWARE_PROVIDERS,
  type Approximation,
  type CircuitSpec,
  type CortexClient,
  type ExperimentDetail,
  type FeedItem,
  type Job,
  type JobRequest,
  type LabConfig,
  type Preview,
  type ProviderId,
} from './api';
import { CircuitViewer } from './CircuitViewer';
import { Histogram } from './Histogram';
import { Landscape } from './Landscape';
import { GateBudget } from './QuantumViz';
import { statusText } from './JobsPanel';
import { FeatureCompare, WaveCompare } from './WaveCompare';
import { PARAM_SHORT } from './signal';

const EDGES = Array.from({ length: 11 }, (_, i) =>
  Math.exp(Math.log(1) + (i / 10) * (Math.log(45) - Math.log(1))),
);

/** Backend feature map (10 relative log band powers, 1 s Hann segments); amplitude is NaN for z-scored traces. */
export function browserFeatures(samples: number[], fs: number): number[] {
  const seg = Math.round(fs);
  const k = Math.max(1, Math.floor(samples.length / seg));
  const n = Math.min(seg, samples.length);
  const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  // only bins below 45 Hz contribute to the relative band powers
  const power = new Float64Array(Math.min(Math.floor(n / 2) + 1, Math.ceil((45 * n) / fs) + 1));
  for (let s = 0; s < k; s++) {
    for (let f = 0; f < power.length; f++) {
      let re = 0,
        im = 0;
      for (let t = 0; t < n; t++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / Math.max(1, n - 1));
        const v = (samples[s * seg + t] - mean) * w;
        re += v * Math.cos((2 * Math.PI * f * t) / n);
        im -= v * Math.sin((2 * Math.PI * f * t) / n);
      }
      power[f] += (re * re + im * im) / k;
    }
  }
  const bp = EDGES.slice(0, -1).map((a, i) => {
    let sum = 0;
    for (let f = 0; f < power.length; f++) {
      const hz = (f * fs) / n;
      if (hz >= a && hz < EDGES[i + 1]) sum += power[f];
    }
    return sum;
  });
  const total = bp.reduce((a, b) => a + b, 0) || 1e-30;
  // the trace endpoint returns z-scored samples, so absolute amplitude is unknown here
  return [...bp.map((b) => Math.log10(b / total + 1e-6)), Number.NaN];
}

export interface RunSettings {
  provider: ProviderId;
  approximation: Approximation;
  reps: number;
  maxCouplings: number | null;
  shots: number;
  trustWeight: number;
}
export const DEFAULT_RUN: RunSettings = {
  provider: 'aer_noisy',
  approximation: 'trust_region',
  reps: 1,
  maxCouplings: 6,
  shots: 1024,
  trustWeight: 0.15,
};

export function toJobRequest(s: RunSettings, baseline?: string | null): JobRequest {
  const spec: CircuitSpec = { reps: s.reps, max_couplings: s.maxCouplings };
  return {
    provider: s.provider,
    approximation: s.approximation,
    baseline: baseline ?? null,
    trust_weight: s.trustWeight,
    spec,
    shots: s.shots,
  };
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="cx-stat" title={hint}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function ExperimentTab({
  detail,
  config,
  client,
  selectedJob,
  run,
  setRun,
  onRun,
  busy,
  onSelectJob,
}: {
  detail: ExperimentDetail | null;
  config: LabConfig | null;
  client: CortexClient;
  selectedJob: Job | null;
  run: RunSettings;
  setRun: (r: RunSettings) => void;
  onRun: (req: JobRequest) => void;
  busy: boolean;
  onSelectJob: (id: string) => void;
}) {
  const [hypothesis, setHypothesis] = useState<string | null>(null);
  const [sim, setSim] = useState<{ fs: number; samples: number[]; features?: number[] } | null>(
    null,
  );
  const [simError, setSimError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const exp = detail?.experiment;
  const shown = hypothesis ?? exp?.best?.bitstring ?? null;
  useEffect(() => setHypothesis(null), [exp?.id]);
  useEffect(() => {
    setPreview(null);
  }, [exp?.id, run]);
  useEffect(() => {
    if (!shown) {
      setSim(null);
      return;
    }
    let alive = true;
    setSimError('');
    client
      .hypothesisTrace(shown, 8)
      .then((t) => alive && setSim(t as { fs: number; samples: number[]; features?: number[] }))
      .catch(
        (e) => alive && (setSim(null), setSimError(e instanceof Error ? e.message : String(e))),
      );
    return () => {
      alive = false;
    };
  }, [client, shown]);
  const simFeatures = useMemo(
    () => (sim ? (sim.features ?? browserFeatures(sim.samples, sim.fs)) : null),
    [sim],
  );
  if (!detail || !exp)
    return (
      <div className="cx-empty">
        <h3>No experiment selected</h3>
        <p>
          Create one from the left pane: a synthetic brain with a hidden configuration, a CHB-MIT
          seizure excerpt, or your own OpenBCI recording.
        </p>
      </div>
    );
  const t = exp.target;
  const providers = config?.providers ?? [];
  const sp =
    selectedJob?.kind === 'sample' && selectedJob.experiment_id === exp.id ? selectedJob : null;
  const lv = config?.param_levels ?? detail.landscape.param_levels;
  return (
    <div className="cx-tab">
      <section className="cx-card">
        <div className="cx-card-head">
          <h4>{exp.title}</h4>
          <span className={`cx-chip ${t.source}`}>{t.source}</span>
        </div>
        <p className="cx-dim">{t.label}</p>
        <div className="cx-stats">
          <Stat
            label="rounds"
            value={exp.rounds ?? detail.jobs.filter((j) => j.kind === 'sample').length}
          />
          <Stat
            label="best loss"
            value={fmt(exp.best?.nonlinear_loss)}
            hint="weighted residual of the nonlinear forward model"
          />
          <Stat
            label="min possible"
            value={fmt(Math.min(...detail.landscape.nonlinear_loss))}
            hint="exact optimum over all 256 hypotheses (classical enumeration)"
          />
          <Stat
            label="consistent set"
            value={
              detail.landscape.nonlinear_loss.filter(
                (l) => l <= detail.landscape.consistency_threshold,
              ).length
            }
            hint="hypotheses within the stochastic noise floor of the best one"
          />
        </div>
        {t.truth_params && (
          <div className="cx-params truth">
            <span>hidden truth {t.truth_bitstring}</span>
            {Object.entries(t.truth_params).map(([k, v]) => (
              <b key={k}>
                {PARAM_SHORT[k] ?? k} {v}
              </b>
            ))}
          </div>
        )}
        {exp.best && (
          <div className="cx-params best">
            <span>
              best so far {exp.best.bitstring}
              {exp.best.consistent ? ' · consistent' : ''}
            </span>
            {Object.entries(exp.best.parameters).map(([k, v]) => (
              <b key={k} className={t.truth_params && t.truth_params[k] === v ? 'match' : ''}>
                {PARAM_SHORT[k] ?? k} {v}
              </b>
            ))}
          </div>
        )}
        {t.source !== 'synthetic' && (
          <p className="cx-note">
            Real EEG: we report parameter configurations of a simplified Wilson–Cowan model that are
            consistent with the spectrum — not validated seizure causes.
          </p>
        )}
      </section>

      <section className="cx-card">
        <div className="cx-card-head">
          <h4>Observed vs simulated</h4>
          {shown && <code>{shown}</code>}
        </div>
        <WaveCompare
          observed={exp.observed_trace}
          simulated={sim}
          observedLabel={
            t.source === 'synthetic'
              ? 'synthetic recording (independent noise)'
              : t.source === 'recording'
                ? 'recorded EEG'
                : 'OpenBCI recording'
          }
          simulatedLabel={`Wilson–Cowan ${shown ?? ''}`}
        />
        <FeatureCompare
          target={t}
          simulated={simFeatures}
          simulatedLabel={
            sim?.features ? 'simulated features' : 'simulated features (computed in browser)'
          }
        />
        {simError && <p className="cx-note warn">{simError}</p>}
      </section>

      <section className="cx-card">
        <div className="cx-card-head">
          <h4>Hypothesis landscape</h4>
          <span className="cx-dim">{sp ? provenance(sp) : 'no job selected'}</span>
        </div>
        <Landscape
          data={detail.landscape}
          truth={t.truth_bitstring}
          counts={sp?.counts}
          evaluation={sp?.evaluation}
          best={exp.best?.bitstring}
          selected={shown}
          onSelect={setHypothesis}
          provenance={sp ? provenance(sp) : 'job'}
        />
        <p className="cx-dim">
          rows: {PARAM_SHORT[detail.landscape.param_names[0]]} {lv[0].join('/')} ×{' '}
          {PARAM_SHORT[detail.landscape.param_names[1]]} {lv[1].join('/')} · cols:{' '}
          {PARAM_SHORT[detail.landscape.param_names[2]]} {lv[2].join('/')} ×{' '}
          {PARAM_SHORT[detail.landscape.param_names[3]]} {lv[3].join('/')}
        </p>
      </section>

      <section className="cx-card">
        <div className="cx-card-head">
          <h4>Run a search round</h4>
          <span className="cx-dim">baseline {exp.baseline ?? '00000000'}</span>
        </div>
        <div className="cx-form">
          <label>
            provider
            <select
              value={run.provider}
              onChange={(e) => setRun({ ...run, provider: e.target.value as ProviderId })}
            >
              {(providers.length
                ? providers
                : Object.keys(PROVIDER_LABEL)
                    .filter((p) => p !== 'agent')
                    .map((id) => ({ id, label: PROVIDER_LABEL[id], available: true, kind: '' }))
              ).map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {!p.available ? ' — unavailable' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            approximation
            <select
              value={run.approximation}
              onChange={(e) => setRun({ ...run, approximation: e.target.value as Approximation })}
            >
              {['trust_region', 'secant', 'feature_regression', 'surrogate', 'regression', 'jacobian'].map(
                (a) => (
                  <option key={a}>{a}</option>
                ),
              )}
            </select>
          </label>
          <label>
            QAOA reps
            <input
              type="number"
              min={1}
              max={4}
              value={run.reps}
              onChange={(e) =>
                setRun({ ...run, reps: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })
              }
            />
          </label>
          <label>
            max couplings
            <input
              type="number"
              min={0}
              max={28}
              value={run.maxCouplings ?? 28}
              onChange={(e) =>
                setRun({
                  ...run,
                  maxCouplings:
                    Number(e.target.value) >= 28 ? null : Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </label>
          <label>
            shots
            <input
              type="number"
              min={64}
              max={8192}
              step={64}
              value={run.shots}
              onChange={(e) =>
                setRun({
                  ...run,
                  shots: Math.min(8192, Math.max(64, Number(e.target.value) || 1024)),
                })
              }
            />
          </label>
          {run.approximation === 'trust_region' && (
            <label>
              trust weight
              <input
                type="number"
                min={0}
                max={2}
                step={0.05}
                value={run.trustWeight}
                onChange={(e) =>
                  setRun({ ...run, trustWeight: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
          )}
        </div>
        {providers.find((p) => p.id === run.provider && !p.available)?.reason && (
          <p className="cx-note warn">{providers.find((p) => p.id === run.provider)?.reason}</p>
        )}
        <div className="cx-actions">
          <button
            className="outline-button"
            disabled={previewBusy}
            onClick={() => {
              setPreviewBusy(true);
              setPreviewError('');
              client
                .preview(exp.id, toJobRequest(run, exp.baseline))
                .then(setPreview)
                .catch((e) => setPreviewError(e instanceof Error ? e.message : String(e)))
                .finally(() => setPreviewBusy(false));
            }}
          >
            <Eye size={14} /> {previewBusy ? 'Compiling…' : 'Compile & inspect'}
          </button>
          <button
            className="primary-button cx-primary"
            disabled={busy || HARDWARE_PROVIDERS.has(run.provider)}
            onClick={() => onRun(toJobRequest(run, exp.baseline))}
            title={
              HARDWARE_PROVIDERS.has(run.provider)
                ? 'Physical QPU runs need explicit confirmation — use the submit action below the analysis'
                : undefined
            }
          >
            <Play size={14} /> Run
          </button>
          <button
            className="outline-button"
            onClick={async () => {
              const blob = await client.download(exp.id);
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `cortex2-experiment-${exp.id}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={14} /> Export
          </button>
        </div>
        {previewError && <p className="cx-note warn">{previewError}</p>}
        {preview && (
          <div className="cx-preview">
            <GateBudget
              gates={preview.transpiled.gates}
              budget={config?.gate_budget ?? preview.transpiled.budget}
              label={`${preview.transpiled.backend} physical`}
            />
            <div className="cx-stats">
              <Stat label="logical gates" value={preview.circuit.gates ?? '—'} />
              <Stat label="2q gates" value={preview.transpiled.two_qubit_gates} />
              <Stat label="2q depth" value={preview.transpiled.two_qubit_depth} />
              <Stat
                label="QUBO rank of optimum"
                value={preview.qubo_quality.rank_of_nonlinear_argmin_under_qubo}
                hint="where the true nonlinear optimum ranks under this quadratic approximation (1 = perfect)"
              />
              <Stat
                label="ideal E[loss]"
                value={fmt(preview.ideal.expected_nonlinear_loss)}
                hint="exact statevector expectation, not a measurement"
              />
              <Stat label="ideal P(consistent)" value={pct(preview.ideal.p_consistent)} />
            </div>
            <CircuitViewer logical={preview.circuit} provenance="compiled preview (not executed)" />
          </div>
        )}
      </section>

      {detail.jobs.length > 0 && (
        <section className="cx-card">
          <div className="cx-card-head">
            <h4>Provider comparison</h4>
            <span className="cx-dim">
              same objective, top-
              {detail.jobs.find((j) => j.evaluation)?.evaluation?.validation_budget ?? 8} validated
            </span>
          </div>
          <table className="cx-table">
            <thead>
              <tr>
                <th>provider</th>
                <th title="best nonlinear loss among validated states">best</th>
                <th title="approximation ratio of the sample distribution">AR</th>
                <th title="probability mass on the consistent set">P(cons)</th>
                <th title="physical gates">gates</th>
              </tr>
            </thead>
            <tbody>
              {detail.jobs
                .filter((j) => j.kind === 'sample')
                .slice(0, 14)
                .map((j) => (
                  <tr
                    key={j.id}
                    onClick={() => onSelectJob(j.id)}
                    className={j.id === sp?.id ? 'selected' : ''}
                  >
                    <td>
                      {PROVIDER_LABEL[j.provider ?? ''] ?? j.provider}
                      {isActive(j) && (
                        <span className={`cx-chip ${j.status}`}>{statusText(j)}</span>
                      )}
                    </td>
                    <td>{fmt(j.evaluation?.best_nonlinear_loss)}</td>
                    <td>{fmt(j.evaluation?.approximation_ratio, 2)}</td>
                    <td>{pct(j.evaluation?.p_consistent)}</td>
                    <td>{j.transpiled?.gates ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export function JobTab({
  job,
  config,
  truth,
}: {
  job: Job | null;
  config: LabConfig | null;
  truth?: string | null;
}) {
  if (!job)
    return (
      <div className="cx-empty">
        <h3>No job selected</h3>
        <p>Select a job in the left pane to see its circuit, samples and evaluation.</p>
      </div>
    );
  const e = job.evaluation;
  const budget = config?.gate_budget ?? 130;
  return (
    <div className="cx-tab">
      <section className="cx-card">
        <div className="cx-card-head">
          <h4>
            {job.kind === 'sample'
              ? (PROVIDER_LABEL[job.provider ?? ''] ?? job.provider)
              : job.kind === 'agent_iteration'
                ? 'Agent design iteration'
                : 'Operator task'}
          </h4>
          <span className={`cx-chip ${job.status}`}>{statusText(job)}</span>
        </div>
        <p className="cx-dim">
          {provenance(job)} ·{' '}
          {job.created_by === 'agent' || job.autonomous
            ? 'dispatched by agent'
            : 'dispatched by you'}{' '}
          · {new Date(job.created_at).toLocaleString()}
        </p>
        {job.error && <p className="cx-note warn">{job.error}</p>}
        <div className="cx-stats">
          {job.approximation && <Stat label="approximation" value={job.approximation} />}
          {job.baseline && <Stat label="baseline" value={<code>{job.baseline}</code>} />}
          {job.spec?.reps != null && <Stat label="QAOA reps" value={job.spec.reps} />}
          {job.qasm_source && (
            <Stat
              label="circuit source"
              value={job.qasm_source === 'agent_qasm' ? 'agent QASM' : 'spec'}
            />
          )}
        </div>
      </section>
      {(job.transpiled || job.circuit) && (
        <section className="cx-card">
          <div className="cx-card-head">
            <h4>Circuit</h4>
          </div>
          {job.transpiled && (
            <GateBudget
              gates={job.transpiled.gates}
              budget={budget}
              label={`${job.transpiled.backend} physical gates`}
            />
          )}
          <div className="cx-stats">
            <Stat label="logical gates" value={job.circuit?.gates ?? '—'} />
            <Stat label="physical gates" value={job.transpiled?.gates ?? '—'} />
            <Stat
              label="2q gates"
              value={job.transpiled?.two_qubit_gates ?? job.circuit?.two_qubit_gates ?? '—'}
            />
            <Stat
              label="2q depth"
              value={job.transpiled?.two_qubit_depth ?? job.circuit?.two_qubit_depth ?? '—'}
            />
            <Stat label="depth" value={job.transpiled?.depth ?? job.circuit?.depth ?? '—'} />
            {job.transpiled?.physical_qubits && (
              <Stat label="physical qubits" value={job.transpiled.physical_qubits.join(',')} />
            )}
          </div>
          <CircuitViewer
            logical={job.circuit}
            physical={job.isa_circuit}
            running={isActive(job)}
            provenance={job.qasm_source === 'agent_qasm' ? 'agent-authored QASM' : 'QAOA from spec'}
          />
        </section>
      )}
      {job.qubo_quality && (
        <section className="cx-card">
          <div className="cx-card-head">
            <h4>Approximation quality</h4>
          </div>
          <div className="cx-stats">
            <Stat label="QUBO argmin" value={<code>{job.qubo_quality.qubo_argmin}</code>} />
            <Stat label="its true loss" value={fmt(job.qubo_quality.qubo_argmin_nonlinear_loss)} />
            <Stat
              label="optimum rank under QUBO"
              value={job.qubo_quality.rank_of_nonlinear_argmin_under_qubo}
            />
            <Stat label="Spearman ρ" value={fmt(job.qubo_quality.spearman, 2)} />
          </div>
        </section>
      )}
      {job.counts && (
        <section className="cx-card">
          <div className="cx-card-head">
            <h4>Samples</h4>
          </div>
          <Histogram
            counts={job.counts}
            evaluation={e}
            truth={truth}
            provenance={provenance(job)}
          />
        </section>
      )}
      {e && (
        <section className="cx-card">
          <div className="cx-card-head">
            <h4>Evaluation</h4>
            <span className="cx-dim">nonlinear re-simulation of the top {e.validation_budget}</span>
          </div>
          <div className="cx-stats">
            <Stat label="best loss" value={fmt(e.best_nonlinear_loss)} />
            <Stat label="optimum" value={fmt(e.min_possible_loss)} />
            <Stat
              label="approx. ratio"
              value={fmt(e.approximation_ratio, 2)}
              hint="1 = samples concentrate on the optimum, 0 = random guessing"
            />
            <Stat
              label="P(consistent)"
              value={`${pct(e.p_consistent)} vs ${pct(e.uniform_p_consistent)}`}
              hint="sampled mass on the consistent set vs uniform random"
            />
            <Stat
              label="E[loss]"
              value={`${fmt(e.expected_nonlinear_loss)} vs ${fmt(e.uniform_expected_loss)}`}
              hint="expected loss under the samples vs uniform"
            />
            <Stat label="distinct states" value={e.distinct_states} />
          </div>
          {e.truth && (
            <div className={`cx-recovery ${e.truth.recovered_exactly ? 'yes' : ''}`}>
              <strong>
                {e.truth.recovered_exactly
                  ? 'Recovered the hidden configuration'
                  : `Best is ${e.truth.best_hamming_distance} bit${e.truth.best_hamming_distance === 1 ? '' : 's'} from the truth`}
              </strong>
              <span>
                P(truth) {pct(e.truth.p_truth, 2)} vs uniform {pct(e.truth.uniform_p_truth, 2)} ·
                truth rank {e.truth.truth_nonlinear_rank}/256 ·{' '}
                {e.truth.truth_in_consistent_set
                  ? 'truth is in the consistent set'
                  : 'truth outside consistent set'}
              </span>
              <span>
                level error:{' '}
                {Object.entries(e.truth.parameter_level_error)
                  .map(([k, v]) => `${PARAM_SHORT[k] ?? k} ${v}`)
                  .join(' · ')}
              </span>
            </div>
          )}
          <table className="cx-table">
            <thead>
              <tr>
                <th>validated</th>
                <th>shots</th>
                <th>loss</th>
                <th>rank</th>
              </tr>
            </thead>
            <tbody>
              {e.validated.map((c) => (
                <tr key={c.bitstring} className={c.bitstring === truth ? 'truth' : ''}>
                  <td>
                    <code>{c.bitstring}</code> {c.consistent && '≈'}
                  </td>
                  <td>{c.samples}</td>
                  <td>{fmt(c.nonlinear_loss)}</td>
                  <td>{c.nonlinear_rank}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {(job.provider_job_id || job.backend || job.runner) && (
        <section className="cx-card">
          <div className="cx-card-head">
            <h4>Provenance</h4>
          </div>
          <dl className="cx-dl">
            {job.provider_job_id && (
              <>
                <dt>provider job</dt>
                <dd>
                  <code>{job.provider_job_id}</code>
                </dd>
              </>
            )}
            {job.backend && (
              <>
                <dt>backend</dt>
                <dd>{job.backend}</dd>
              </>
            )}
            {job.quantum_seconds != null && (
              <>
                <dt>QPU seconds</dt>
                <dd>{job.quantum_seconds}</dd>
              </>
            )}
            {job.ideal_tvd != null && (
              <>
                <dt>TVD vs ideal</dt>
                <dd title="total variation distance between measured and exact statevector distribution">
                  {fmt(job.ideal_tvd)}
                </dd>
              </>
            )}
            {job.runner &&
              Object.entries(job.runner)
                .filter(([, v]) => typeof v !== 'object')
                .map(([k, v]) => (
                  <span key={k} className="cx-dl-row">
                    <dt>{k.replace(/_/g, ' ')}</dt>
                    <dd>{String(v)}</dd>
                  </span>
                ))}
          </dl>
        </section>
      )}
    </div>
  );
}

export function FeedTab({ items }: { items: FeedItem[] }) {
  if (!items.length)
    return (
      <div className="cx-empty">
        <h3>Talk to the research agent</h3>
        <p>
          It keeps a long-running view of every job and experiment, can dispatch and babysit work
          within your budgets, and reports here.
        </p>
      </div>
    );
  return (
    <div className="cx-feed">
      {[...items].reverse().map((item) => (
        <article
          key={item.id}
          className={`message ${item.kind === 'user' ? 'user' : 'assistant'} cx-feed-${item.kind}`}
        >
          <div className="message-meta">
            <span>
              {item.kind === 'user'
                ? 'You'
                : item.kind === 'agent'
                  ? 'Agent'
                  : item.kind === 'result'
                    ? 'Result'
                    : item.kind === 'error'
                      ? 'Error'
                      : 'System'}
            </span>
            <time>
              {new Date(item.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </time>
          </div>
          <div className="message-text">{item.text}</div>
        </article>
      ))}
    </div>
  );
}
