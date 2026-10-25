import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { fmt, type CortexClient, type Revision } from './api';

/** Image from an authenticated endpoint (object URL, revoked on unmount). */
export function AuthImage({
  load,
  deps,
  alt,
  className = 'cx-revision-img',
}: {
  load: () => Promise<string>;
  deps: unknown[];
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setError('');
    load()
      .then((u) => {
        made = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Image unavailable'));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="cx-dim">Image unavailable: {error}</p>;
  if (!url) return <div className="cx-img-loading" aria-label="Loading image" />;
  return <img className={className} src={url} alt={alt} />;
}

export function ArtifactImage({ client, path, alt }: { client: CortexClient; path: string; alt?: string }) {
  return (
    <AuthImage
      load={() => client.artifact(path)}
      deps={[client, path]}
      alt={alt ?? 'What the agent looked at: rendered waveform comparison and samples'}
    />
  );
}

/** Shallow key-by-key diff of two specs. */
export function specDiff(a?: Record<string, unknown> | null, b?: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out: Array<{ key: string; before: string; after: string }> = [];
  const show = (v: unknown) =>
    v == null
      ? '—'
      : Array.isArray(v)
        ? `[${v.map((x) => (typeof x === 'number' ? x.toFixed(3) : String(x))).join(', ')}]`
        : String(v);
  for (const k of keys) {
    const before = show(a?.[k]);
    const after = show(b?.[k]);
    if (before !== after) out.push({ key: k, before, after });
  }
  return out;
}

function DiffBlock({ text }: { text: string }) {
  return (
    <pre className="cx-diff">
      {text.split('\n').map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'del'
                : line.startsWith('@@')
                  ? 'hunk'
                  : ''
          }
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export function RevisionCard({
  revision,
  client,
  onSelectJob,
}: {
  revision: Revision;
  client: CortexClient;
  onSelectJob: (id: string) => void;
}) {
  const [open, setOpen] = useState(revision.number <= 1);
  const [trace, setTrace] = useState(false);
  const diff = specDiff(
    revision.spec_before as Record<string, unknown>,
    revision.spec_after as Record<string, unknown>,
  );
  const approxChanged = revision.approximation_before !== revision.approximation_after;
  return (
    <article className={`cx-revision ${revision.verdict}`}>
      <button className="cx-revision-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="cx-rev-n">r{revision.number}</span>
        <span className="cx-rev-change">{revision.change || 'revision'}</span>
        <span
          className={`cx-verdict ${revision.verdict}`}
          title="Computed from measured metrics, not the model's claim"
        >
          {revision.verdict}
        </span>
      </button>
      <div className="cx-rev-metric">
        <span>{revision.metric?.replace(/_/g, ' ') ?? 'metric'}</span>
        <b>{fmt(revision.metric_before)}</b>→<b>{fmt(revision.metric_after)}</b>
        {revision.secondary?.physical_gates_after != null && (
          <small>
            gates {revision.secondary.physical_gates_before ?? '—'}→
            {revision.secondary.physical_gates_after}
          </small>
        )}
      </div>
      {open && (
        <div className="cx-rev-body">
          {revision.observation && (
            <section>
              <h5>Observed</h5>
              <p>{revision.observation}</p>
            </section>
          )}
          {revision.diagnosis && (
            <section>
              <h5>Diagnosis</h5>
              <p>{revision.diagnosis}</p>
            </section>
          )}
          {revision.rationale && (
            <section>
              <h5>Why this change</h5>
              <p>{revision.rationale}</p>
            </section>
          )}
          {(diff.length > 0 || approxChanged) && (
            <section>
              <h5>Change</h5>
              <table className="cx-spec-diff">
                <tbody>
                  {approxChanged && (
                    <tr>
                      <td>approximation</td>
                      <td className="del">{revision.approximation_before ?? '—'}</td>
                      <td className="add">{revision.approximation_after ?? '—'}</td>
                    </tr>
                  )}
                  {diff.map((d) => (
                    <tr key={d.key}>
                      <td>{d.key}</td>
                      <td className="del">{d.before}</td>
                      <td className="add">{d.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {revision.qasm_diff && (
            <section>
              <h5>QASM diff</h5>
              <DiffBlock text={revision.qasm_diff} />
            </section>
          )}
          {revision.image && (
            <section>
              <h5>What it looked at</h5>
              <ArtifactImage client={client} path={revision.image} />
            </section>
          )}
          {!!revision.job_ids?.length && (
            <div className="cx-rev-jobs">
              {revision.job_ids.map((id) => (
                <button key={id} className="cx-link" onClick={() => onSelectJob(id)}>
                  job {id.slice(0, 6)}
                </button>
              ))}
            </div>
          )}
          {!!revision.tool_trace?.length && (
            <section>
              <button className="cx-link" aria-expanded={trace} onClick={() => setTrace((t) => !t)}>
                {trace ? 'Hide' : 'Show'} tool trace ({revision.tool_trace.length})
              </button>
              {trace && (
                <ol className="cx-trace-list">
                  {revision.tool_trace.map((t, i) => (
                    <li key={i}>
                      <code>{t.tool}</code> {t.summary}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          <p className="cx-dim">
            {revision.model} · {new Date(revision.created_at).toLocaleString()}
          </p>
        </div>
      )}
    </article>
  );
}

export function AgentTimeline({
  revisions,
  client,
  onSelectJob,
  agentConfigured,
  model,
}: {
  revisions: Revision[];
  client: CortexClient;
  onSelectJob: (id: string) => void;
  agentConfigured: boolean;
  model: string;
}) {
  const sorted = [...revisions].sort((a, b) => b.number - a.number);
  const improved = revisions.filter((r) => r.verdict === 'improved').length;
  return (
    <div className="cx-timeline">
      <div className="cx-timeline-head">
        <Sparkles size={15} />
        <span>
          {model} circuit engineer · {revisions.length} revision{revisions.length === 1 ? '' : 's'}{' '}
          · {improved} measured improvement{improved === 1 ? '' : 's'}
        </span>
      </div>
      {!agentConfigured && (
        <p className="cx-note warn">
          No agent model provider is configured on the server (GEMINI_API_KEY / AGENT_PROVIDERS). Iterations will fail
          until it is set.
        </p>
      )}
      {!sorted.length && (
        <p className="cx-empty-line">
          No revisions yet. “Run iteration” lets the agent construct → compile → run → look →
          critique → revise.
        </p>
      )}
      {sorted.map((r) => (
        <RevisionCard key={r.id} revision={r} client={client} onSelectJob={onSelectJob} />
      ))}
    </div>
  );
}
