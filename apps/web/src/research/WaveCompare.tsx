import type { Target } from './api';

const W = 320;

function path(values: number[], h: number, span = 3.2) {
  if (!values.length) return '';
  const step = W / Math.max(1, values.length - 1);
  return values
    .map(
      (v, i) =>
        `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h / 2 - (Math.max(-span, Math.min(span, v)) / span) * (h / 2 - 3)).toFixed(1)}`,
    )
    .join('');
}
/** Down-sample to ≤ n points by striding (display only). */
export function decimate(values: number[], n = 600) {
  if (values.length <= n) return values;
  const stride = values.length / n;
  return Array.from({ length: n }, (_, i) => values[Math.floor(i * stride)]);
}

/** Observed vs simulated waveform overlay (both z-scored) with a shared time axis. */
export function WaveCompare({
  observed,
  simulated,
  observedLabel,
  simulatedLabel,
  seconds = 2,
}: {
  observed?: { fs: number; samples: number[] } | null;
  simulated?: { fs: number; samples: number[] } | null;
  observedLabel: string;
  simulatedLabel: string;
  seconds?: number;
}) {
  const h = 92;
  const clip = (s?: { fs: number; samples: number[] } | null) =>
    s ? decimate(s.samples.slice(0, Math.round(s.fs * seconds))) : [];
  const o = clip(observed);
  const m = clip(simulated);
  return (
    <figure className="cx-figure cx-wave">
      <svg
        viewBox={`0 0 ${W} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Observed versus simulated EEG"
      >
        <path d={`M0 ${h / 2}H${W}`} className="cx-axis" />
        {o.length > 0 && <path d={path(o, h)} className="cx-wave-observed" />}
        {m.length > 0 && <path d={path(m, h)} className="cx-wave-sim" />}
      </svg>
      <figcaption>
        <span className="cx-key observed" /> {observedLabel}
        <span className="cx-key sim" />{' '}
        {m.length ? simulatedLabel : 'select a hypothesis to simulate'}
        <span className="cx-dim">· z-scored · {seconds}s</span>
      </figcaption>
    </figure>
  );
}

/** Observed vs best-hypothesis spectral feature vector (relative log band power). */
export function FeatureCompare({
  target,
  simulated,
  simulatedLabel,
}: {
  target: Target;
  simulated?: number[] | null;
  simulatedLabel: string;
}) {
  const names = target.feature_names;
  const all = [...target.features, ...(simulated ?? [])].filter(Number.isFinite);
  const lo = Math.min(...all, -3);
  const hi = Math.max(...all, 0);
  const span = hi - lo || 1;
  const short = (n: string) =>
    n.replace('rel_logpow_', '').replace('Hz', '').replace('log_amplitude', 'amp');
  return (
    <figure className="cx-figure cx-features">
      <div className="cx-feature-grid" role="table" aria-label="Feature comparison">
        {names.map((n, i) => {
          const w = target.weights[i] ?? 0;
          return (
            <div
              className={`cx-feature ${w === 0 ? 'unweighted' : ''}`}
              role="row"
              key={n}
              title={`${n}: observed ${target.features[i]?.toFixed(3)}${simulated && Number.isFinite(simulated[i]) ? `, simulated ${simulated[i].toFixed(3)}` : ''}, weight ${w.toFixed(2)}`}
            >
              <div className="cx-feature-bars">
                <span
                  className="obs"
                  style={{ height: `${(100 * (target.features[i] - lo)) / span}%` }}
                />
                {simulated && Number.isFinite(simulated[i]) && (
                  <span
                    className="sim"
                    style={{ height: `${(100 * (simulated[i] - lo)) / span}%` }}
                  />
                )}
              </div>
              <small>{short(n)}</small>
            </div>
          );
        })}
      </div>
      <figcaption>
        <span className="cx-key observed" /> observed features <span className="cx-key sim" />{' '}
        {simulated ? simulatedLabel : 'no hypothesis selected'}
        <span className="cx-dim">· log₁₀ relative band power, Hz bands; faded = weight 0</span>
      </figcaption>
    </figure>
  );
}
