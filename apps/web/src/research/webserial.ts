/**
 * OpenBCI Cyton read directly in Chrome over the Web Serial API (FTDI USB dongle), replacing the
 * laptop-side Python bridge. Produces the same EEGFrame shape the bridge websocket sent (filtered µV
 * samples at 125 Hz, band powers, quality, line noise, blink count, eyes-closed alpha state).
 * Visualisation-grade estimates only — not clinical interpretation.
 */
import { BANDS, type AlphaState, type Band, type EEGFrame } from './api';
import { bandPowers } from './signal';

// ---- minimal Web Serial typings (lib.dom does not ship them)
interface SerialPortLike {
  open(o: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(o?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>;
}
const serialApi = (): SerialLike | null =>
  typeof navigator !== 'undefined' && 'serial' in navigator
    ? ((navigator as unknown as { serial: SerialLike }).serial ?? null)
    : null;
export const webSerialSupported = () => serialApi() !== null;

export const CYTON_CHANNELS = ['Fp1', 'Fp2', 'C3', 'C4', 'P7', 'P8', 'O1', 'O2'];
export const CYTON_FS = 250;
const UV_PER_COUNT = (4.5 / 24 / (2 ** 23 - 1)) * 1e6;
const FULL_SCALE_UV = 187_500;
const MAINS = 60;
const PACKET = 33;

// ---- 33-byte packet parser with resync
export class CytonParser {
  private buf = new Uint8Array(0);
  /** Feed raw bytes; returns µV samples (8 channels) per valid packet. */
  push(chunk: Uint8Array): number[][] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: number[][] = [];
    let i = 0;
    while (i + PACKET <= merged.length) {
      if (merged[i] !== 0xa0 || (merged[i + 32] & 0xf0) !== 0xc0 || merged[i + 32] > 0xc6) {
        i++; // resync: slide until header + footer line up
        continue;
      }
      const ch: number[] = [];
      for (let c = 0; c < 8; c++) {
        const o = i + 2 + c * 3;
        let v = (merged[o] << 16) | (merged[o + 1] << 8) | merged[o + 2];
        if (v & 0x800000) v -= 0x1000000;
        ch.push(v * UV_PER_COUNT);
      }
      out.push(ch);
      i += PACKET;
    }
    this.buf = merged.slice(i);
    if (this.buf.length > 4096) this.buf = this.buf.slice(-PACKET);
    return out;
  }
}

// ---- causal IIR filters (RBJ biquads): 1–45 Hz band-pass (2× HP + 2× LP) + mains notch
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private primed = false;
  constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}
  static make(kind: 'hp' | 'lp' | 'notch', f0: number, fs: number, q: number) {
    const w = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    let b: [number, number, number];
    if (kind === 'hp') b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    else if (kind === 'lp') b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    else b = [1, -2 * cos, 1];
    return new Biquad(b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }
  step(x: number) {
    if (!this.primed) {
      // start in steady state for a DC input (kills the huge Cyton offset transient)
      this.primed = true;
      const dcGain = (this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2);
      this.x1 = this.x2 = x;
      this.y1 = this.y2 = x * dcGain;
    }
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
function makeChain(fs: number) {
  const s = [
    Biquad.make('hp', 1, fs, 0.5412),
    Biquad.make('hp', 1, fs, 1.3066),
    Biquad.make('lp', 45, fs, 0.5412),
    Biquad.make('lp', 45, fs, 1.3066),
    Biquad.make('notch', MAINS, fs, 30),
  ];
  return (x: number) => s.reduce((v, f) => f.step(v), x);
}

class Ring {
  data: number[] = [];
  constructor(private max: number) {}
  push(v: number) {
    this.data.push(v);
    if (this.data.length > this.max * 1.5) this.data = this.data.slice(-this.max);
  }
  last(n: number) {
    return this.data.slice(-n);
  }
}

// ---- detectors ported from research/bridge/signals.py
function median(a: number[]) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
class BlinkDetector {
  count = 0;
  private lastT = -1e9;
  constructor(
    private fs: number,
    private thresholdUv = 40,
    private k = 5,
    private refractory = 0.45,
  ) {}
  update(frontal: number[][], t: number): boolean {
    const fs = this.fs;
    if (!frontal.length || frontal[0].length < Math.floor(fs * 0.6)) return false;
    let hit = false;
    for (const ch of frontal) {
      const recent = ch.slice(-Math.floor(0.25 * fs));
      const base =
        ch.length > Math.floor(0.9 * fs) ? ch.slice(-Math.floor(2 * fs), -Math.floor(0.3 * fs)) : ch;
      const med = median(base);
      const mad = median(base.map((v) => Math.abs(v - med))) * 1.4826 + 1e-6;
      const peak = Math.max(...recent.map(Math.abs));
      if (peak > this.thresholdUv && peak > this.k * mad) hit = true;
    }
    if (hit && t - this.lastT > this.refractory) {
      this.lastT = t;
      this.count += 1;
      return true;
    }
    return false;
  }
}
class AlphaDetector {
  state: AlphaState = 'unknown';
  alpha = 0;
  baseline: number | null = null;
  private history: number[] = [];
  update(occipital: number[][], fs: number) {
    if (!occipital.length || occipital[0].length < 2 * fs) return;
    const fr = occipital.map((ch) => (bandPowers(ch.slice(-2 * fs), fs).alpha ?? 0) / 100);
    const instant = fr.reduce((a, b) => a + b, 0) / fr.length;
    this.alpha = this.history.length ? 0.65 * this.alpha + 0.35 * instant : instant;
    this.history.push(this.alpha);
    if (this.history.length > 240) this.history.shift();
    if (this.history.length < 8) {
      this.baseline = null;
      this.state = 'unknown';
      return;
    }
    const s = [...this.history].sort((a, b) => a - b);
    this.baseline = Math.max(s[Math.floor(0.2 * (s.length - 1))], 0.03);
    const enter = this.alpha >= Math.max(2 * this.baseline, 0.35);
    const stay = this.alpha >= Math.max(1.5 * this.baseline, 0.2625);
    this.state = enter || (this.state === 'eyes_closed' && stay) ? 'eyes_closed' : 'eyes_open';
  }
}
function std(a: number[]) {
  if (!a.length) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
}
function quality(raw: number[], filt: number[]): string {
  if (!raw.length || !filt.length) return 'no data';
  let maxAbs = 0;
  let same = 0;
  for (let i = 0; i < raw.length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(raw[i]));
    if (i && raw[i] === raw[i - 1]) same++;
  }
  if (maxAbs >= 0.95 * FULL_SCALE_UV || same / Math.max(1, raw.length - 1) > 0.9) return 'railed';
  const sd = std(filt);
  if (sd < 0.3) return 'flat';
  if (sd > 200) return 'noisy';
  return 'ok';
}
/** Mains power ÷ 1–45 Hz power (raw), via Goertzel-free DFT over a 1 s window. */
function lineNoise(raw: number[], fs: number): number {
  const x = raw.slice(-fs);
  if (x.length < fs) return 0;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  const pow = (f: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < x.length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
      const a = (2 * Math.PI * f * i) / fs;
      re += (x[i] - m) * w * Math.cos(a);
      im -= (x[i] - m) * w * Math.sin(a);
    }
    return re * re + im * im;
  };
  let line = 0;
  for (let f = MAINS - 2; f <= MAINS + 2; f++) line += pow(f);
  let eeg = 1e-12;
  for (let f = 1; f < 45; f++) eeg += pow(f);
  return line / eeg;
}

export type UsbState = 'idle' | 'connecting' | 'streaming' | 'error';
export interface UsbCallbacks {
  onFrame(frame: EEGFrame): void;
  onState(state: UsbState, message: string): void;
}

/** Live Cyton session: request port → reset → stream → frames at ~20 Hz. */
export class CytonUSB {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stopped = false;
  private parser = new CytonParser();
  private fs = CYTON_FS;
  private filters = CYTON_CHANNELS.map(() => makeChain(CYTON_FS));
  private raw = CYTON_CHANNELS.map(() => new Ring(CYTON_FS * 64));
  private filt = CYTON_CHANNELS.map(() => new Ring(CYTON_FS * 64));
  private pending: number[][] = CYTON_CHANNELS.map(() => []);
  private blink = new BlinkDetector(CYTON_FS);
  private alpha = new AlphaDetector();
  private alphaT = 0;
  private timer = 0;
  private lastData = 0;
  /** Total filtered samples received (per channel), for recordings. */
  samplesTotal = 0;

  constructor(private cb: UsbCallbacks) {}

  async start() {
    const serial = serialApi();
    if (!serial) throw new Error('Web Serial is not available — use Chrome or Edge on desktop.');
    this.cb.onState('connecting', 'choose the OpenBCI dongle…');
    const port = await serial.requestPort({ filters: [{ usbVendorId: 0x0403 }] });
    try {
      await port.open({ baudRate: 115200, bufferSize: 1 << 16 });
    } catch (e) {
      throw new Error(
        `Cannot open the dongle (${e instanceof Error ? e.message : e}). Stop the Python bridge / OpenBCI GUI — only one program can hold the port.`,
      );
    }
    this.port = port;
    this.stopped = false;
    this.cb.onState('connecting', 'resetting board…');
    this.reader = port.readable!.getReader();
    await this.write('s');
    await this.write('v');
    const banner = await this.readUntil('$$$', 3000);
    if (!banner.includes('$$$')) {
      if (/device failed to poll host|no response/i.test(banner) || !banner.trim())
        throw new Error(
          'The dongle opened but the board did not answer. Turn the Cyton on (PC position), dongle switch on GPIO_6, battery charged.',
        );
    }
    await this.write('b');
    this.lastData = performance.now();
    this.cb.onState('streaming', `cyton (USB) at ${this.fs} Hz · ${CYTON_CHANNELS.join(', ')}`);
    void this.readLoop();
    this.timer = window.setInterval(() => this.emit(), 50);
  }

  private async write(s: string) {
    const w = this.port?.writable?.getWriter();
    if (!w) return;
    try {
      await w.write(new TextEncoder().encode(s));
    } finally {
      w.releaseLock();
    }
  }

  private async readUntil(token: string, ms: number) {
    const dec = new TextDecoder();
    let text = '';
    const deadline = performance.now() + Math.max(ms, 1500);
    while (performance.now() < deadline && !text.includes(token)) {
      const left = deadline - performance.now();
      const r = await Promise.race([
        this.reader!.read(),
        new Promise<null>((res) => setTimeout(() => res(null), left)),
      ]);
      if (!r) break;
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
    return text;
  }

  private async readLoop() {
    try {
      while (!this.stopped && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        for (const s of this.parser.push(value)) {
          this.lastData = performance.now();
          this.samplesTotal++;
          s.forEach((v, c) => {
            const y = this.filters[c](v);
            this.raw[c].push(v);
            this.filt[c].push(y);
            this.pending[c].push(y);
          });
        }
      }
    } catch (e) {
      if (!this.stopped) this.cb.onState('error', `USB read failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private emit() {
    if (performance.now() - this.lastData > 5000) {
      this.cb.onState('error', 'no samples for 5 s (board off, out of range or battery low)');
      this.lastData = performance.now();
    }
    if (!this.pending[0].length) return;
    const fs = this.fs;
    const step = 2; // 250 → 125 Hz for the UI, like the bridge
    const samples = this.pending.map((ch) =>
      ch.filter((_, i) => i % step === 0).map((v) => Math.round(v * 100) / 100),
    );
    this.pending = CYTON_CHANNELS.map(() => []);
    const w = this.filt.map((r) => r.last(2 * fs));
    const r = this.raw.map((x) => x.last(2 * fs));
    const per = w.map((ch) => (ch.length >= fs ? bandPowers(ch, fs) : ({} as Record<Band, number>)));
    const valid = per.filter((p) => Object.keys(p).length);
    const bands = Object.fromEntries(
      BANDS.map((b) => [b, valid.length ? valid.reduce((a, p) => a + (p[b] ?? 0), 0) / valid.length : 0]),
    ) as Record<Band, number>;
    const now = performance.now() / 1000;
    const frontal = [0, 1].map((i) => this.filt[i].last(Math.floor(2.5 * fs)));
    const blink = this.blink.update(frontal, now);
    if (now - this.alphaT >= 0.25) {
      this.alphaT = now;
      this.alpha.update([6, 7].map((i) => this.filt[i].last(2 * fs)), fs);
    }
    this.cb.onFrame({
      board: 'cyton-usb',
      fs: fs / step,
      t: Date.now() / 1000,
      channel_names: CYTON_CHANNELS,
      samples,
      bands,
      per_channel_bands: per,
      quality: r.map((x, i) => quality(x, w[i])),
      line_noise: r.map((x) => Math.round(lineNoise(x, fs) * 1000) / 1000),
      blink,
      blink_count: this.blink.count,
      alpha_state: this.alpha.state,
      alpha_fraction: Math.round(this.alpha.alpha * 1e4) / 1e4,
      alpha_baseline: this.alpha.baseline === null ? undefined : Math.round(this.alpha.baseline * 1e4) / 1e4,
      state: 'streaming',
    });
  }

  /** Last `seconds` of filtered 250 Hz EEG as a recording payload (≤60 s). */
  snapshot(seconds: number, label: string) {
    const n = Math.round(Math.min(60, seconds) * this.fs);
    return {
      label,
      fs: this.fs,
      channel_names: CYTON_CHANNELS,
      data: this.filt.map((r) => r.last(n).map((v) => Math.round(v * 1000) / 1000)),
    };
  }

  async stop() {
    this.stopped = true;
    window.clearInterval(this.timer);
    try {
      await this.write('s');
    } catch {
      /* port already gone */
    }
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    this.reader = null;
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.cb.onState('idle', '');
  }
}
