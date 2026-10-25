import { useMemo, useState } from 'react';
import type { Circuit, CircuitOp } from './api';

export interface PlacedOp extends CircuitOp {
  col: number;
  rows: number[];
}

/** ASAP column placement; multi-qubit gates block every wire they span. Wires = used qubits only. */
export function layoutCircuit(circuit: Circuit): {
  ops: PlacedOp[];
  wires: number[];
  columns: number;
} {
  const used = new Set<number>();
  for (const op of circuit.operations) op.qubits.forEach((q) => used.add(q));
  const wires = [...used].sort((a, b) => a - b);
  if (!wires.length) for (let i = 0; i < circuit.qubits; i++) wires.push(i);
  const row = new Map(wires.map((q, i) => [q, i]));
  const free = new Array(wires.length).fill(0);
  const ops: PlacedOp[] = [];
  for (const op of circuit.operations) {
    const rows = op.qubits.map((q) => row.get(q) ?? 0);
    const lo = Math.min(...rows),
      hi = Math.max(...rows);
    let col = 0;
    for (let r = lo; r <= hi; r++) col = Math.max(col, free[r]);
    for (let r = lo; r <= hi; r++) free[r] = col + 1;
    ops.push({ ...op, col, rows });
  }
  return { ops, wires, columns: Math.max(1, ...free) };
}

const LABEL: Record<string, string> = {
  h: 'H',
  x: 'X',
  sx: '√X',
  rx: 'Rx',
  ry: 'Ry',
  rz: 'Rz',
  u: 'U',
  u3: 'U',
  p: 'P',
  id: 'I',
  y: 'Y',
  z: 'Z',
  s: 'S',
  t: 'T',
};
const TWO = new Set(['rzz', 'cz', 'ecr', 'cx', 'swap', 'rzx', 'cp', 'crz']);

export function CircuitViewer({
  logical,
  physical,
  running,
  provenance,
}: {
  logical?: Circuit | null;
  physical?: Circuit | null;
  running?: boolean;
  provenance: string;
}) {
  const [mode, setMode] = useState<'logical' | 'physical'>(logical ? 'logical' : 'physical');
  const [hover, setHover] = useState<number | null>(null);
  const circuit = (mode === 'physical' ? physical : logical) ?? logical ?? physical;
  const layout = useMemo(() => (circuit ? layoutCircuit(circuit) : null), [circuit]);
  if (!circuit || !layout)
    return (
      <figure className="cx-figure cx-circuit-empty">
        <p>No circuit for this job.</p>
      </figure>
    );
  const cw = 26,
    rh = 24,
    left = 34;
  const width = left + layout.columns * cw + 16;
  const height = layout.wires.length * rh + 12;
  const y = (r: number) => 14 + r * rh;
  const x = (c: number) => left + c * cw + cw / 2;
  const hovered = hover != null ? layout.ops[hover] : null;
  return (
    <figure className="cx-figure cx-circuit">
      <div className="cx-segmented small" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'logical'}
          className={mode === 'logical' ? 'selected' : ''}
          disabled={!logical}
          onClick={() => setMode('logical')}
        >
          logical {logical?.gates != null && <span>{logical.gates}</span>}
        </button>
        <button
          role="tab"
          aria-selected={mode === 'physical'}
          className={mode === 'physical' ? 'selected' : ''}
          disabled={!physical}
          onClick={() => setMode('physical')}
        >
          physical {physical?.gates != null && <span>{physical.gates}</span>}
        </button>
      </div>
      <div className="cx-circuit-scroll">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${mode} circuit, ${layout.ops.length} operations`}
        >
          {layout.wires.map((q, r) => (
            <g key={q}>
              <text x={4} y={y(r) + 3.5} className="cx-wire-label">
                {mode === 'physical' ? `Q${q}` : `q${q}`}
              </text>
              <path d={`M${left - 6} ${y(r)}H${width - 6}`} className="cx-wire" />
            </g>
          ))}
          {running && (
            <rect
              className="cx-sweep"
              x={left}
              y={2}
              width={cw * 1.4}
              height={height - 4}
              rx={6}
              style={{ ['--sweep' as string]: `${layout.columns * cw}px` }}
            />
          )}
          {layout.ops.map((op, i) => {
            const cx = x(op.col);
            const active = hover === i;
            if (op.gate === 'measure')
              return (
                <g
                  key={i}
                  className="cx-gate measure"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                >
                  <rect x={cx - 9} y={y(op.rows[0]) - 9} width={18} height={18} rx={4} />
                  <path
                    d={`M${cx - 5} ${y(op.rows[0]) + 3}a5 5 0 0 1 10 0M${cx} ${y(op.rows[0]) + 3}l3.5-6`}
                  />
                </g>
              );
            if (op.rows.length >= 2 || TWO.has(op.gate)) {
              const [a, b] = [Math.min(...op.rows), Math.max(...op.rows)];
              return (
                <g
                  key={i}
                  className={`cx-gate two ${op.gate} ${active ? 'hover' : ''}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                >
                  <path d={`M${cx} ${y(a)}V${y(b)}`} />
                  {op.rows.map((r, k) => (
                    <circle
                      key={k}
                      cx={cx}
                      cy={y(r)}
                      r={op.gate === 'rzz' || op.gate === 'ecr' ? 5.5 : 4}
                    />
                  ))}
                  {(op.gate === 'rzz' || op.gate === 'ecr') && (
                    <text x={cx + 7} y={(y(a) + y(b)) / 2 + 3} className="cx-gate-mini">
                      {op.gate === 'rzz' ? 'ZZ' : 'ECR'}
                    </text>
                  )}
                </g>
              );
            }
            return (
              <g
                key={i}
                className={`cx-gate one ${op.gate} ${active ? 'hover' : ''}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              >
                <rect x={cx - 10} y={y(op.rows[0]) - 9} width={20} height={18} rx={5} />
                <text x={cx} y={y(op.rows[0]) + 3.5} textAnchor="middle">
                  {LABEL[op.gate] ?? op.gate.slice(0, 3)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption>
        {hovered ? (
          <span className="cx-gate-detail">
            <b>{hovered.gate}</b> on{' '}
            {hovered.qubits.map((q) => (mode === 'physical' ? `Q${q}` : `q${q}`)).join(', ')}
            {hovered.params?.length
              ? ` · θ = ${hovered.params.map((p) => p.toFixed(3)).join(', ')}`
              : ''}{' '}
            · layer {hovered.col + 1}
          </span>
        ) : (
          <>
            {provenance} · {circuit.gates ?? layout.ops.length} gates · depth{' '}
            {circuit.depth ?? layout.columns} · 2q {circuit.two_qubit_gates ?? '—'}
            {circuit.truncated && ' · truncated for display'}
          </>
        )}
      </figcaption>
    </figure>
  );
}
