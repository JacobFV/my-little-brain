import { describe, expect, it, vi } from 'vitest';
import { RESEARCH_ANCHORS } from '@little-brain/brain';
import { ApiError, CortexClient, errorMessage, provenance } from './api';
import { appendRing, tokenExpiry } from './hooks';
import {
  anchorsFromEEG,
  bandPowers,
  bitstringLevels,
  cellIndex,
  channelAnchors,
  histogram,
  landscapeCell,
} from './signal';
import { layoutCircuit } from './CircuitViewer';
import { marginals } from './QuantumViz';
import { specDiff } from './AgentTimeline';

const idx = (n: string) => RESEARCH_ANCHORS.indexOf(n);

describe('channel → anchor mapping', () => {
  it('maps referential, aliased and bipolar names', () => {
    expect(channelAnchors('C3')).toEqual([idx('C3')]);
    expect(channelAnchors('EEG Fp1-REF')).toEqual([idx('Fp1')]);
    expect(channelAnchors('T3')).toEqual([idx('T7')]);
    expect(channelAnchors('FP1-F7')).toEqual([idx('Fp1'), idx('F7')]);
    expect(channelAnchors('T8-P8')).toEqual([idx('T8'), idx('P8')]);
    expect(channelAnchors('EXG Channel 3')).toEqual([]);
  });
  it('projects measured frames onto anchors and labels them measured', () => {
    const fs = 256;
    const sine = (f: number) =>
      Array.from({ length: 512 }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
    const s = anchorsFromEEG({ fs, channel_names: ['O1', 'Fz'], samples: [sine(10), sine(2)] }, [
      sine(10),
      sine(2),
    ]);
    expect(s.mapped).toBe(2);
    expect(s.values[idx('O1')].source).toBe('measured');
    expect(s.intensities[idx('O1')]).toBeGreaterThan(s.intensities[idx('Fz')]);
    expect(s.intensities[idx('Cz')]).toBeLessThan(0.1);
  });
});

describe('band power', () => {
  it('puts a 10 Hz sine in alpha', () => {
    const fs = 250;
    const x = Array.from({ length: 512 }, (_, i) => Math.sin((2 * Math.PI * 10 * i) / fs));
    const b = bandPowers(x, fs);
    expect(b.alpha).toBeGreaterThan(80);
    expect(b.delta + b.theta + b.alpha + b.beta + b.gamma).toBeCloseTo(100, 0);
  });
  it('returns zeros for too-short input', () => {
    expect(bandPowers([1, 2, 3], 250).alpha).toBe(0);
  });
});

describe('landscape layout', () => {
  it('maps levels to a unique 16×16 cell and back', () => {
    const levels: number[][] = [];
    for (let k = 0; k < 256; k++) {
      const bits = Array.from({ length: 8 }, (_, i) => (k >> i) & 1);
      levels.push([0, 1, 2, 3].map((j) => bits[2 * j] + 2 * bits[2 * j + 1]));
    }
    const seen = new Set(levels.map((l) => JSON.stringify(landscapeCell(l))));
    expect(seen.size).toBe(256);
    const { row, col } = landscapeCell(levels[77]);
    expect(cellIndex({ levels }, row, col)).toBe(77);
  });
  it('decodes little-endian 2-bit parameters from qiskit bitstrings', () => {
    // qubit 0 is the rightmost char: bits q0..q7 = 1,0,0,1,1,1,0,1 → levels [1,2,3,2]
    expect(bitstringLevels('10111001')).toEqual([1, 2, 3, 2]);
  });
});

describe('histogram', () => {
  it('sorts, normalises and folds the tail', () => {
    const h = histogram({ a: 1, b: 5, c: 2, d: 0, e: 2 }, 2);
    expect(h.total).toBe(10);
    expect(h.bins.map((b) => b.state)).toEqual(['b', 'c']);
    expect(h.bins[0].p).toBeCloseTo(0.5);
    expect(h.other).toBeCloseTo(0.3);
    expect(histogram(null).bins).toEqual([]);
  });
  it('computes per-qubit marginals with qubit 0 rightmost', () => {
    const m = marginals({ '00000001': 3, '10000000': 1 });
    expect(m[0]).toBeCloseTo(0.75);
    expect(m[7]).toBeCloseTo(0.25);
  });
});

describe('circuit layout', () => {
  it('packs gates ASAP and blocks spanned wires for two-qubit gates', () => {
    const l = layoutCircuit({
      qubits: 3,
      operations: [
        { gate: 'h', qubits: [0] },
        { gate: 'h', qubits: [2] },
        { gate: 'rzz', qubits: [0, 2] },
        { gate: 'rx', qubits: [1] },
      ],
    });
    expect(l.ops.map((o) => o.col)).toEqual([0, 0, 1, 2]);
    expect(l.columns).toBe(3);
  });
  it('uses only the physical qubits that appear', () => {
    expect(
      layoutCircuit({
        qubits: 133,
        operations: [
          { gate: 'sx', qubits: [40] },
          { gate: 'ecr', qubits: [40, 41] },
        ],
      }).wires,
    ).toEqual([40, 41]);
  });
});

describe('api client', () => {
  it('surfaces FastAPI detail strings and validation lists', () => {
    expect(errorMessage(503, { detail: 'IBM_QUANTUM_TOKEN is not configured' })).toBe(
      'IBM_QUANTUM_TOKEN is not configured',
    );
    expect(errorMessage(422, { detail: [{ msg: 'field required' }, { msg: 'bad' }] })).toBe(
      'field required; bad',
    );
    expect(errorMessage(500, null)).toBe('Request failed (HTTP 500).');
  });
  it('sends the bearer token and throws ApiError with the server message', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ detail: 'queue unavailable' }), { status: 503 }),
    );
    const c = new CortexClient('tok', 'http://x', fetcher as unknown as typeof fetch);
    await expect(c.createJob('e1', { provider: 'thrml' })).rejects.toMatchObject({
      status: 503,
      message: 'queue unavailable',
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://x/v1/experiments/e1/jobs');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
  it('maps network failures to status 0', async () => {
    const c = new CortexClient(null, '', (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    const err = await c.config().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });
  it('labels provenance honestly', () => {
    expect(
      provenance({
        provider: 'ibm_quantum',
        backend: 'ibm_torino',
        status: 'completed',
        kind: 'sample',
      }),
    ).toBe('IBM ibm_torino · measured');
    expect(
      provenance({ provider: 'thrml', backend: null, status: 'completed', kind: 'sample' }),
    ).toContain('software');
    expect(provenance(null)).toBe('illustrative');
  });
});

describe('helpers', () => {
  it('keeps a bounded ring buffer per channel', () => {
    const b = appendRing([[1, 2, 3]], [[4, 5]], 4);
    expect(b).toEqual([[2, 3, 4, 5]]);
    expect(appendRing([], [[1], [Number.NaN]], 3)).toEqual([[1], [0]]);
  });
  it('reads JWT expiry without verification', () => {
    const payload = btoa(JSON.stringify({ exp: 123 })).replace(/=+$/, '');
    expect(tokenExpiry(`h.${payload}.s`)).toBe(123);
    expect(tokenExpiry('dev')).toBeNull();
  });
  it('diffs specs key by key', () => {
    expect(specDiff({ reps: 1, max_couplings: 28 }, { reps: 2, max_couplings: 28 })).toEqual([
      { key: 'reps', before: '1', after: '2' },
    ]);
  });
});
