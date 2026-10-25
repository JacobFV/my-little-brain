import { useMemo, useState } from 'react';
import type { Evaluation, Landscape as LandscapeData } from './api';
import { landscapeCell, lossColor, PARAM_SHORT } from './signal';

/** 16×16 map of all 256 hypotheses: colour = nonlinear loss, overlays = sampling and truth. */
export function Landscape({
  data,
  truth,
  counts,
  evaluation,
  best,
  selected,
  onSelect,
  provenance,
}: {
  data: LandscapeData;
  truth?: string | null;
  counts?: Record<string, number> | null;
  evaluation?: Evaluation | null;
  best?: string | null;
  selected?: string | null;
  onSelect?: (bitstring: string) => void;
  provenance: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { min, max } = useMemo(() => {
    const v = data.nonlinear_loss.filter(Number.isFinite);
    return { min: Math.min(...v), max: Math.max(...v) };
  }, [data]);
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const maxP = counts && total ? Math.max(...Object.values(counts)) / total : 0;
  const validated = new Set((evaluation?.validated ?? []).map((c) => c.bitstring));
  const cell = 100 / 16;
  const names = data.param_names;
  const lv = data.param_levels;
  const h = hover != null ? hover : null;
  return (
    <figure className="cx-figure cx-landscape">
      <div className="cx-landscape-wrap">
        <div className="cx-axis-y" aria-hidden>
          <span>{PARAM_SHORT[names[0]] ?? names[0]} → </span>
          <small>× {PARAM_SHORT[names[1]] ?? names[1]}</small>
        </div>
        <svg
          viewBox="0 0 100 100"
          role="grid"
          aria-label="Hypothesis landscape: 256 parameter combinations"
          onPointerLeave={() => setHover(null)}
        >
          {data.states.map((state, k) => {
            const { row, col } = landscapeCell(data.levels[k]);
            const loss = data.nonlinear_loss[k];
            const consistent = loss <= data.consistency_threshold;
            const p = counts && total ? (counts[state] ?? 0) / total : 0;
            return (
              <g
                key={state}
                role="gridcell"
                aria-label={`${state}: loss ${loss.toFixed(3)}`}
                onPointerEnter={() => setHover(k)}
                onClick={() => onSelect?.(state)}
                className="cx-cell"
              >
                <rect
                  x={col * cell + 0.15}
                  y={row * cell + 0.15}
                  width={cell - 0.3}
                  height={cell - 0.3}
                  rx={0.9}
                  fill={lossColor(loss, min, max)}
                />
                {consistent && (
                  <rect
                    x={col * cell + 0.55}
                    y={row * cell + 0.55}
                    width={cell - 1.1}
                    height={cell - 1.1}
                    rx={0.7}
                    className="cx-cell-consistent"
                  />
                )}
                {p > 0 && maxP > 0 && (
                  <circle
                    cx={col * cell + cell / 2}
                    cy={row * cell + cell / 2}
                    r={0.6 + 2.3 * Math.sqrt(p / maxP)}
                    className={`cx-cell-sample ${validated.has(state) ? 'validated' : ''}`}
                  />
                )}
                {state === truth && (
                  <path
                    d={`M${col * cell + cell / 2} ${row * cell + 1.1}l1.05 2.1 2.3.33-1.67 1.62.4 2.3-2.08-1.1-2.08 1.1.4-2.3-1.67-1.62 2.3-.33z`}
                    className="cx-cell-truth"
                  />
                )}
                {state === best && (
                  <rect
                    x={col * cell + 0.25}
                    y={row * cell + 0.25}
                    width={cell - 0.5}
                    height={cell - 0.5}
                    rx={0.9}
                    className="cx-cell-best"
                  />
                )}
                {state === selected && (
                  <rect
                    x={col * cell}
                    y={row * cell}
                    width={cell}
                    height={cell}
                    rx={1}
                    className="cx-cell-selected"
                  />
                )}
              </g>
            );
          })}
          {[4, 8, 12].map((v) => (
            <g key={v} className="cx-grid-major">
              <path d={`M${v * cell} 0V100`} />
              <path d={`M0 ${v * cell}H100`} />
            </g>
          ))}
        </svg>
        <div className="cx-axis-x" aria-hidden>
          {PARAM_SHORT[names[2]] ?? names[2]} → <small>× {PARAM_SHORT[names[3]] ?? names[3]}</small>
        </div>
        {h != null && (
          <div className="cx-landscape-tip" role="status">
            <code>{data.states[h]}</code>
            {data.levels[h].map((l, j) => (
              <span key={j}>
                {PARAM_SHORT[names[j]] ?? names[j]} <b>{lv[j][l]}</b>
              </span>
            ))}
            <span>
              loss <b>{data.nonlinear_loss[h].toFixed(3)}</b>
            </span>
            {data.qubo_energy && (
              <span>
                QUBO <b>{data.qubo_energy[h].toFixed(3)}</b>
              </span>
            )}
            {counts && (
              <span>
                samples <b>{counts[data.states[h]] ?? 0}</b>
              </span>
            )}
            {data.nonlinear_loss[h] <= data.consistency_threshold && (
              <em>consistent with observation</em>
            )}
            {data.states[h] === truth && <em>hidden ground truth</em>}
          </div>
        )}
      </div>
      <figcaption>
        exact nonlinear loss for all 256 hypotheses (forward model, not a measurement) ·{' '}
        <span className="cx-key ring" /> consistent set · <span className="cx-key dot" />{' '}
        {provenance} samples · ★ truth · click to simulate
      </figcaption>
    </figure>
  );
}
