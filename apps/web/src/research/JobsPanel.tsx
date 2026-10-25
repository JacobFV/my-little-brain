import { useEffect, useState } from 'react';
import { Atom, Bot, Cpu, Dices, Flame, Sigma, Sparkles, User, X } from 'lucide-react';
import { elapsed, fmt, isActive, PROVIDER_LABEL, type Job, type Session } from './api';

export function ProviderIcon({ provider, kind }: { provider?: string | null; kind?: string }) {
  if (kind && kind !== 'sample') return <Sparkles size={14} />;
  switch (provider) {
    case 'ibm_quantum':
    case 'ionq_qpu':
    case 'qbraid_qpu':
      return <Atom size={14} />;
    case 'ionq_simulator':
    case 'qbraid_simulator':
    case 'aer_ideal':
    case 'aer_noisy':
      return <Cpu size={14} />;
    case 'thrml':
      return <Flame size={14} />;
    case 'random':
      return <Dices size={14} />;
    default:
      return <Sigma size={14} />;
  }
}

export function statusText(job: Job): string {
  if (job.status === 'submitted')
    return `IBM queue${job.provider_status ? ` · ${job.provider_status}` : ''}`;
  return job.status;
}

/** The agent's long-running session view: every job, live. */
export function JobsPanel({
  jobs,
  selectedId,
  onSelect,
  onCancel,
  session,
  onSession,
  signedIn,
}: {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (job: Job) => void;
  onCancel: (job: Job) => void;
  session: Session | null;
  onSession: (patch: Partial<Session>) => void;
  signedIn: boolean;
}) {
  const [, setNow] = useState(0);
  const active = jobs.filter(isActive);
  useEffect(() => {
    if (!active.length) return;
    const t = window.setInterval(() => setNow((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [active.length]);
  return (
    <section className="cx-section cx-jobs">
      <header className="cx-section-head">
        <h3>Jobs</h3>
        <span className="cx-count">{active.length ? `${active.length} running` : jobs.length}</span>
      </header>
      {session && (
        <div className="cx-autopilot">
          <div className="plain-setting">
            <span>
              <Bot size={14} /> Agent autopilot
            </span>
            <button
              className={`toggle ${session.autopilot ? 'on' : ''}`}
              role="switch"
              aria-label="Agent autopilot"
              aria-checked={session.autopilot}
              onClick={() => onSession({ autopilot: !session.autopilot })}
            >
              <span />
            </button>
          </div>
          <small>
            {session.autopilot
              ? 'Babysitting jobs and dispatching follow-ups'
              : 'Agent acts only when asked'}{' '}
            · {session.autonomous_jobs_total}/{session.max_autonomous_jobs} autonomous jobs · QPU{' '}
            {session.qpu_jobs_total}/{session.qpu_jobs_budget}
            {session.allow_autonomous_qpu ? ' (agent may submit)' : ' (you submit)'}
          </small>
          <div className="cx-budget-edit">
            <label>
              autonomous jobs
              <input
                type="number"
                min={0}
                max={200}
                value={session.max_autonomous_jobs}
                onChange={(e) =>
                  onSession({ max_autonomous_jobs: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
            <label>
              QPU budget
              <input
                type="number"
                min={0}
                max={50}
                value={session.qpu_jobs_budget}
                onChange={(e) =>
                  onSession({ qpu_jobs_budget: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
            <label className="cx-check">
              <input
                type="checkbox"
                checked={session.allow_autonomous_qpu}
                onChange={(e) => onSession({ allow_autonomous_qpu: e.target.checked })}
              />
              agent may use QPU
            </label>
          </div>
          {session.operator_memory && (
            <details className="cx-memory">
              <summary>Agent session memory</summary>
              <p>{session.operator_memory}</p>
            </details>
          )}
        </div>
      )}
      {!signedIn ? (
        <p className="cx-empty-line">Sign in to see and run jobs.</p>
      ) : !jobs.length ? (
        <p className="cx-empty-line">
          No jobs yet. Start an experiment, then run it on a provider.
        </p>
      ) : (
        <ul className="cx-job-list">
          {jobs.slice(0, 60).map((job) => (
            <li key={job.id}>
              <button
                className={`cx-job ${job.id === selectedId ? 'selected' : ''}`}
                aria-pressed={job.id === selectedId}
                onClick={() => onSelect(job)}
              >
                <span className={`cx-job-icon ${job.status}`}>
                  <ProviderIcon provider={job.provider} kind={job.kind} />
                </span>
                <span className="cx-job-main">
                  <strong>
                    {job.kind === 'sample'
                      ? (PROVIDER_LABEL[job.provider ?? ''] ?? job.provider)
                      : job.kind === 'agent_iteration'
                        ? 'Design iteration'
                        : 'Operator'}
                  </strong>
                  <small>
                    {job.created_by === 'agent' || job.autonomous ? (
                      <>
                        <Bot size={10} /> agent
                      </>
                    ) : (
                      <>
                        <User size={10} /> you
                      </>
                    )}{' '}
                    ·{' '}
                    {elapsed(
                      job.timings?.queued ?? job.created_at,
                      isActive(job) ? undefined : (job.timings?.finished ?? job.updated_at),
                    )}
                    {job.evaluation && ` · loss ${fmt(job.evaluation.best_nonlinear_loss)}`}
                    {job.transpiled && ` · ${job.transpiled.gates}g`}
                  </small>
                  {job.error && <small className="cx-job-error">{job.error}</small>}
                </span>
                <span className={`cx-chip ${job.status}`}>{statusText(job)}</span>
              </button>
              {isActive(job) && (
                <button
                  className="cx-icon cx-job-cancel"
                  aria-label="Cancel job"
                  title="Cancel job"
                  onClick={() => onCancel(job)}
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
