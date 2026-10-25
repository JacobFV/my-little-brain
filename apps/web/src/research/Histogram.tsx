import { useState } from 'react';
import type { Evaluation } from './api';
import { histogram } from './signal';

/** Measured bitstring frequencies with validated / consistent / truth markers. */
export function Histogram({
  counts,
  evaluation,
  truth,
  limit = 16,
  provenance,
  animate = false,
  compact = false,
}: {
  counts?: Record<string, number> | null;
  evaluation?: Evaluation | null;
  truth?: string | null;
  limit?: number;
  provenance: string;
  animate?: boolean;
  compact?: boolean;
}) {
  const { bins, total, other } = histogram(counts, limit);
  const [hover, setHover] = useState<string | null>(null);
  const byState = new Map((evaluation?.candidates ?? []).map((c) => [c.bitstring, c]));
  const validated = new Set((evaluation?.validated ?? []).map((c) => c.bitstring));
  const max = Math.max(1e-9, ...bins.map((b) => b.p));
  if (!bins.length)
    return (
      <figure className="cx-figure cx-hist-empty">
        <p>No samples yet.</p>
        <figcaption>{provenance}</figcaption>
      </figure>
    );
  const hovered = hover ? byState.get(hover) : null;
  return (
    <figure className={`cx-figure cx-histogram ${compact ? 'compact' : ''}`}>
      <div className="cx-hist-rows" role="list" aria-label="Measured bitstring frequencies">
        {bins.map((b) => {
          const c = byState.get(b.state);
          return (
            <div
              role="listitem"
              key={b.state}
              className={`cx-hist-row ${b.state === truth ? 'truth' : ''} ${validated.has(b.state) ? 'validated' : ''} ${c?.consistent ? 'consistent' : ''}`}
              onPointerEnter={() => setHover(b.state)}
              onPointerLeave={() => setHover((h) => (h === b.state ? null : h))}
              tabIndex={0}
              onFocus={() => setHover(b.state)}
              onBlur={() => setHover(null)}
            >
              <code>{b.state}</code>
              <div className="cx-hist-track">
                <span
                  className={animate ? 'grow' : ''}
                  style={{ width: `${(100 * b.p) / max}%` }}
                />
              </div>
              <span className="cx-hist-n">{b.count}</span>
              <span className="cx-hist-flags" aria-hidden>
                {b.state === truth && <i title="hidden ground truth">★</i>}
                {validated.has(b.state) && <i title="re-simulated with the nonlinear model">✓</i>}
                {c?.consistent && <i title="within the noise floor of the best hypothesis">≈</i>}
              </span>
            </div>
          );
        })}
      </div>
      {hovered && (
        <div className="cx-hist-tip" role="status">
          <code>{hovered.bitstring}</code> · {hovered.samples} shots · loss{' '}
          {hovered.nonlinear_loss.toFixed(3)} (rank {hovered.nonlinear_rank}/256)
          <br />
          {Object.entries(hovered.parameters)
            .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
            .join(' · ')}
        </div>
      )}
      <figcaption>
        {provenance} · {total} shots
        {other > 0
          ? ` · ${(other * 100).toFixed(1)}% in ${Object.keys(counts ?? {}).length - bins.length} other states`
          : ''}
        {!compact && (
          <span className="cx-legend">
            <i>★</i> truth <i>✓</i> validated <i>≈</i> consistent
          </span>
        )}
      </figcaption>
    </figure>
  );
}
