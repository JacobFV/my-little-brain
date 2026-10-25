/** Pure helpers: EEG channel → anchor mapping, band power, landscape layout, histogram shaping. */
import { RESEARCH_ANCHORS } from '@little-brain/brain';
import { BAD_QUALITY, BANDS, channelQuality, type Band, type EEGFrame, type Landscape } from './api';

/** Anchors over visual cortex, where eyes-closed alpha is strongest. */
export const OCCIPITAL = new Set(['O1', 'O2']);

/** Old / alternative 10-20 names → modern names used by the anchors. */
const ALIASES: Record<string, string> = {
  T3: 'T7',
  T4: 'T8',
  T5: 'P7',
  T6: 'P8',
  FPZ: 'Fz',
  AFZ: 'Fz',
  OZ: 'O1',
  POZ: 'Pz',
  FCZ: 'Cz',
  CPZ: 'Pz',
};

/** Normalised anchor lookup (case-insensitive). */
const ANCHOR_INDEX = new Map(RESEARCH_ANCHORS.map((n, i) => [n.toUpperCase(), i]));

/**
 * Indices of the anchors a channel refers to. Referential names ("C3", "EEG Fp1-REF") map to one
 * anchor; bipolar montages ("FP1-F7", CHB-MIT) map to both endpoints; unknown names map to none.
 */
export function channelAnchors(name: string): number[] {
  const cleaned = name
    .toUpperCase()
    .replace(/^EEG\s*/, '')
    .replace(/[-_ ]?(REF|LE|AVG|A1|A2|M1|M2)$/, '')
    .trim();
  const parts = cleaned
    .split(/[-–]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const raw of parts) {
    const p = ALIASES[raw] ? ALIASES[raw].toUpperCase() : raw;
    const i = ANCHOR_INDEX.get(p);
    if (i !== undefined && !out.includes(i)) out.push(i);
  }
  return out;
}

/** Relative band power (%) of one channel using a Hann-windowed FFT (radix-2 truncated). */
export function bandPowers(samples: number[], fs: number): Record<Band, number> {
  const empty = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  let n = 1;
  while (n * 2 <= samples.length) n *= 2;
  if (n < 32 || !fs) return empty;
  const x = samples.slice(-n);
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++)
    re[i] = (x[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const ranges: Record<Band, [number, number]> = {
    delta: [1, 4],
    theta: [4, 8],
    alpha: [8, 13],
    beta: [13, 30],
    gamma: [30, 45],
  };
  const out = { ...empty };
  let total = 0;
  for (let k = 1; k < n / 2; k++) {
    const f = (k * fs) / n;
    if (f < 1 || f >= 45) continue;
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    for (const b of BANDS) if (f >= ranges[b][0] && f < ranges[b][1]) out[b] += p;
  }
  if (total <= 0) return empty;
  for (const b of BANDS) out[b] = (100 * out[b]) / total;
  return out;
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let j = 0; j < len / 2; j++) {
        const wr = Math.cos(ang * j),
          wi = Math.sin(ang * j);
        const ur = re[i + j],
          ui = im[i + j];
        const vr = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
        const vi = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
      }
  }
}

export function rms(samples: number[]): number {
  if (!samples.length) return 0;
  const m = samples.reduce((a, b) => a + b, 0) / samples.length;
  return Math.sqrt(samples.reduce((a, b) => a + (b - m) * (b - m), 0) / samples.length);
}

export interface AnchorState {
  intensities: number[];
  labels: string[];
  values: Array<Record<string, number | string>>;
  mapped: number;
}

/**
 * Project measured channel activity onto anchors. Intensity = relative (alpha+beta+gamma) power
 * blended with normalised RMS amplitude, averaged over channels touching an anchor.
 */
export function anchorsFromEEG(frame: EEGFrame, buffer: number[][]): AnchorState {
  const n = RESEARCH_ANCHORS.length;
  const sums = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  const labels = RESEARCH_ANCHORS.slice();
  const values: Array<Record<string, number | string>> = RESEARCH_ANCHORS.map(() => ({}));
  const rmsAll = frame.channel_names.map((_, i) => rms(buffer[i] ?? frame.samples[i] ?? []));
  const maxRms = Math.max(1e-9, ...rmsAll);
  const quality = channelQuality(frame);
  frame.channel_names.forEach((name, ci) => {
    const bands =
      frame.per_channel_bands?.[ci] ?? bandPowers(buffer[ci] ?? frame.samples[ci] ?? [], frame.fs);
    const fast = ((bands.alpha ?? 0) + (bands.beta ?? 0) + (bands.gamma ?? 0)) / 100;
    const bad = BAD_QUALITY.has(quality[ci]);
    let level = 0.55 * Math.min(1, fast * 1.3) + 0.45 * (rmsAll[ci] / maxRms);
    if (bad) level *= 0.15; // railed / flat electrodes are dimmed, not shown as activity
    for (const a of channelAnchors(name)) {
      sums[a] += level;
      counts[a] += 1;
      labels[a] =
        counts[a] === 1
          ? `${RESEARCH_ANCHORS[a]} · ${name}`
          : `${RESEARCH_ANCHORS[a]} · ${counts[a]} channels`;
      values[a] = {
        channel: counts[a] === 1 ? name : `${counts[a]} channels`,
        'δ delta %': bands.delta ?? 0,
        'θ theta %': bands.theta ?? 0,
        'α alpha %': bands.alpha ?? 0,
        'β beta %': bands.beta ?? 0,
        'γ gamma %': bands.gamma ?? 0,
        'rms (raw units)': rmsAll[ci],
        quality: quality[ci],
        ...(frame.line_noise?.[ci] !== undefined ? { 'mains ratio': frame.line_noise[ci] } : {}),
        source: 'measured',
      };
    }
  });
  const intensities = sums.map((s, i) => (counts[i] ? s / counts[i] : 0.04));
  // Eyes closed (bridge alpha detector): posterior alpha rhythm — glow the occipital anchors.
  if (frame.alpha_state === 'eyes_closed')
    RESEARCH_ANCHORS.forEach((name, i) => {
      if (OCCIPITAL.has(name)) intensities[i] = Math.max(intensities[i], 0.85);
    });
  return {
    intensities,
    labels,
    values,
    mapped: counts.filter(Boolean).length,
  };
}

/** Gentle travelling wave used when nothing is streaming — always labelled illustrative. */
export function idleAnchors(t: number): AnchorState {
  return {
    intensities: RESEARCH_ANCHORS.map(
      (_, i) => 0.18 + 0.16 * Math.sin(t * 0.9 + i * 0.7) + 0.08 * Math.sin(t * 2.3 + i),
    ),
    labels: RESEARCH_ANCHORS.slice(),
    values: RESEARCH_ANCHORS.map(() => ({ source: 'illustrative idle animation' })),
    mapped: 0,
  };
}

/** 16×16 layout: row = P·4 + c2 (drive, inhibition); col = c1·4 + τ (recurrence, time constant). */
export function landscapeCell(levels: number[]): { row: number; col: number } {
  return { row: levels[0] * 4 + levels[1], col: levels[2] * 4 + levels[3] };
}
/** Inverse of `landscapeCell` against a landscape: (row, col) → state index (or -1). */
export function cellIndex(landscape: Pick<Landscape, 'levels'>, row: number, col: number): number {
  return landscape.levels.findIndex((l) => l[0] * 4 + l[1] === row && l[2] * 4 + l[3] === col);
}
/** Little-endian 2-bit decode (bit0 + 2·bit1 per parameter; qubit 0 is the rightmost character). */
export function bitstringLevels(bitstring: string): number[] {
  const bits = bitstring.split('').reverse().map(Number);
  return [0, 1, 2, 3].map((j) => (bits[2 * j] || 0) + 2 * (bits[2 * j + 1] || 0));
}

export interface HistBin {
  state: string;
  count: number;
  p: number;
}
/** Sort, normalise and cap a counts map; the remainder is folded into one "other" bin. */
export function histogram(
  counts: Record<string, number> | undefined | null,
  limit = 16,
): { bins: HistBin[]; total: number; other: number } {
  const entries = Object.entries(counts ?? {}).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return { bins: [], total: 0, other: 0 };
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const bins = entries
    .slice(0, limit)
    .map(([state, count]) => ({ state, count, p: count / total }));
  const other = entries.slice(limit).reduce((a, [, v]) => a + v, 0) / total;
  return { bins, total, other };
}

/** Loss → colour on a perceptual-ish ramp (low loss = warm/bright, high = cool/pale). */
export function lossColor(loss: number, min: number, max: number): string {
  const t =
    max > min
      ? Math.min(
          1,
          Math.max(
            0,
            (Math.log(loss + 1e-9) - Math.log(min + 1e-9)) /
              (Math.log(max + 1e-9) - Math.log(min + 1e-9)),
          ),
        )
      : 0;
  const stops = [
    [240, 123, 143],
    [242, 176, 103],
    [196, 214, 165],
    [151, 196, 190],
    [226, 232, 228],
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export const PARAM_SHORT: Record<string, string> = {
  excitatory_drive: 'P drive',
  inhibitory_gain: 'c₂ inhibition',
  recurrent_excitation: 'c₁ recurrence',
  synaptic_tau_ms: 'τ ms',
};
