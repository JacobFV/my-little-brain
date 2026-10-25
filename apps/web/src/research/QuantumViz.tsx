import { useEffect, useState } from 'react';
import { Atom, X } from 'lucide-react';
import { isActive, PROVIDER_LABEL, provenance, type Job } from './api';
import { Histogram } from './Histogram';
import { histogram } from './signal';
import { CircuitViewer } from './CircuitViewer';

/** P(qubit q measured as 1); qubit 0 is the rightmost bitstring character. */
export function marginals(counts: Record<string, number> | undefined | null, n = 8): number[] {
  const out = new Array(n).fill(0);
  let total = 0;
  for (const [s, c] of Object.entries(counts ?? {})) {
    total += c;
    for (let q = 0; q < n; q++) if (s[s.length - 1 - q] === '1') out[q] += c;
  }
  return total ? out.map((v) => v / total) : out;
}

const PARAM_OF_QUBIT = ['P', 'P', 'c₂', 'c₂', 'c₁', 'c₁', 'τ', 'τ'];

export function GateBudget({
  gates,
  budget,
  label,
}: {
  gates?: number | null;
  budget: number;
  label: string;
}) {
  if (gates == null) return null;
  const ratio = gates / budget;
  return (
    <div
      className={`cx-budget ${ratio > 1 ? 'above' : ''}`}
      title={`${gates} physical gates · ~${budget} is a soft target (reference line), not a limit`}
    >
      <span>{label}</span>
      <div className="cx-budget-track">
        <span
          style={{ width: `${Math.min(100, (100 * gates) / Math.max(gates, budget * 1.5))}%` }}
        />
        <i style={{ left: `${(100 * budget) / Math.max(gates, budget * 1.5)}%` }} />
      </div>
      <b>
        {gates}
        <small> · ~{budget} target</small>
      </b>
    </div>
  );
}

/** Center-stage view of the selected quantum / sampling job. */
export function QuantumViz({
  job,
  budget,
  truth,
  onClose,
}: {
  job: Job | null;
  budget: number;
  truth?: string | null;
  onClose: () => void;
}) {
  const running = !!job && isActive(job);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 120);
    return () => window.clearInterval(t);
  }, [running]);
  const m = marginals(job?.counts);
  const hasCounts = !!job?.counts && histogram(job.counts).total > 0;
  return (
    <section className="cx-qviz" aria-label="Quantum computation">
      <header>
        <Atom size={15} />
        <strong>
          {job ? (PROVIDER_LABEL[job.provider ?? ''] ?? job.provider) : 'Quantum hypothesis search'}
        </strong>
        {job && (
          <span className={`cx-chip ${job.status}`}>
            {job.status === 'submitted'
              ? `IBM queue${job.provider_status ? ` · ${job.provider_status}` : ''}`
              : job.status}
          </span>
        )}
        <button className="cx-icon" aria-label="Hide quantum view" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {!job ? (
        <p className="cx-empty-line">
          Run a job to watch 8 qubits search the 256 brain-parameter hypotheses.
        </p>
      ) : (
        <>
          <div className="cx-orbs" role="list" aria-label="Qubit marginals P(1)">
            {m.map((p, q) => {
              const shimmer =
                running && !hasCounts ? 0.5 + 0.35 * Math.sin(tick * 0.5 + q * 0.9) : p;
              return (
                <div
                  className="cx-orb"
                  role="listitem"
                  key={q}
                  title={`q${q} (${PARAM_OF_QUBIT[q]} bit ${q % 2}) · P(1) = ${hasCounts ? p.toFixed(3) : '—'}`}
                >
                  <span
                    style={{ ['--p' as string]: String(shimmer) }}
                    className={running && !hasCounts ? 'busy' : ''}
                  />
                  <small>q{q}</small>
                  <em>{PARAM_OF_QUBIT[q]}</em>
                </div>
              );
            })}
          </div>
          <p className="cx-orb-caption">
            {hasCounts
              ? `measured P(1) per qubit · ${provenance(job)}`
              : running
                ? 'waiting for shots · animation is illustrative'
                : 'no samples'}
          </p>
          {job.transpiled && (
            <GateBudget
              gates={job.transpiled.gates}
              budget={budget}
              label={`${job.transpiled.backend} physical gates`}
            />
          )}
          {(job.circuit || job.isa_circuit) && (
            <CircuitViewer
              logical={job.circuit}
              physical={job.isa_circuit}
              running={running}
              provenance={
                job.qasm_source === 'agent_qasm' ? 'agent-authored QASM' : 'QAOA from spec'
              }
            />
          )}
          {hasCounts && (
            <Histogram
              counts={job.counts}
              evaluation={job.evaluation}
              truth={truth}
              limit={8}
              provenance={provenance(job)}
              animate
              compact
            />
          )}
        </>
      )}
    </section>
  );
}
