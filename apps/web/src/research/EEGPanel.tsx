import { Eye, Radio } from 'lucide-react';
import { BANDS, type EEGFrame } from './api';
import type { BridgeStatus, LiveEEG } from './hooks';
import { bandPowers } from './signal';
import { decimate } from './WaveCompare';

export function averageBands(frame: EEGFrame | null, buffer: number[][]) {
  if (!frame) return null;
  if (frame.bands && Object.keys(frame.bands).length) return frame.bands;
  const per = frame.channel_names.map(
    (_, i) =>
      frame.per_channel_bands?.[i] ?? bandPowers(buffer[i] ?? frame.samples[i] ?? [], frame.fs),
  );
  if (!per.length) return null;
  return Object.fromEntries(
    BANDS.map((b) => [b, per.reduce((a, p) => a + (p[b] ?? 0), 0) / per.length]),
  );
}

/** Multichannel scrolling trace strip (stage) — measured data only. */
export function TraceStrip({ live, maxChannels = 8 }: { live: LiveEEG; maxChannels?: number }) {
  const f = live.frame;
  if (!f) return null;
  const rows = f.channel_names.slice(0, maxChannels);
  const h = 22;
  return (
    <div className="cx-tracestrip" aria-label="Live EEG traces">
      {rows.map((name, i) => {
        const data = decimate(live.buffer[i] ?? [], 360);
        const m = data.reduce((a, b) => a + b, 0) / Math.max(1, data.length);
        const span = Math.max(1e-9, ...data.map((v) => Math.abs(v - m)));
        const d = data
          .map(
            (v, k) =>
              `${k ? 'L' : 'M'}${((k / Math.max(1, data.length - 1)) * 300).toFixed(1)},${(h / 2 - ((v - m) / span) * (h / 2 - 1)).toFixed(1)}`,
          )
          .join('');
        return (
          <div className="cx-trace-row" key={name + i}>
            <span>{name}</span>
            <svg viewBox={`0 0 300 ${h}`} preserveAspectRatio="none">
              <path d={d} />
            </svg>
          </div>
        );
      })}
      <small className="cx-trace-meta">
        {live.source === 'bridge' ? 'OpenBCI bridge' : 'cloud stream'} · {f.board ?? 'board'} ·{' '}
        {f.fs} Hz · {f.quality ?? 'unverified'} · auto-scaled per channel · measured
      </small>
    </div>
  );
}

export function EEGPanel({
  bridge,
  live,
  onIngestToken,
  ingestToken,
}: {
  bridge: BridgeStatus;
  live: LiveEEG;
  onIngestToken?: () => void;
  ingestToken?: string;
}) {
  const bands = averageBands(live.frame, live.buffer);
  return (
    <section className="cx-section cx-eeg">
      <header className="cx-section-head">
        <h3>EEG sources</h3>
        <span className={`cx-live ${live.source !== 'none' ? 'on' : ''}`}>
          <Radio size={12} />{' '}
          {live.source === 'bridge'
            ? 'bridge live'
            : live.source === 'cloud'
              ? 'cloud live'
              : 'no signal'}
        </span>
      </header>
      <div className="cx-source">
        <span className={`status-dot ${bridge === 'open' ? 'live' : ''}`} />
        <span>
          <strong>OpenBCI bridge</strong>
          <small>
            {bridge === 'open'
              ? 'ws://127.0.0.1:8765 connected'
              : bridge === 'connecting'
                ? 'looking for local bridge…'
                : 'not running'}
          </small>
        </span>
      </div>
      {bridge !== 'open' && (
        <p className="cx-help">
          Start it next to the headset:
          <code>
            python research/bridge/openbci.py --board cyton --serial-port /dev/tty.usbserial-…
          </code>
          or <code>--board synthetic</code> to test without hardware.
        </p>
      )}
      {onIngestToken && (
        <div className="cx-source-actions">
          <button className="outline-button" onClick={onIngestToken}>
            Pair bridge with cloud
          </button>
          {ingestToken && (
            <p className="cx-help">
              Device token (45 min, paste into the bridge only):
              <code className="cx-secret">CORTEX_INGEST_TOKEN={ingestToken}</code>
            </p>
          )}
        </div>
      )}
      {bands && (
        <div className="cx-bands" aria-label="Relative band power, measured">
          {BANDS.map((b) => (
            <div key={b} className={`cx-band ${b}`}>
              <span>{b}</span>
              <div>
                <i style={{ width: `${Math.min(100, bands[b] ?? 0)}%` }} />
              </div>
              <b>{(bands[b] ?? 0).toFixed(0)}%</b>
            </div>
          ))}
          <small className="cx-dim">
            <Eye size={11} /> blinks detected: {live.blinkCount} · relative power, all channels
          </small>
        </div>
      )}
    </section>
  );
}
