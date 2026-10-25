import { useState } from 'react';
import { Circle, Eye, EyeOff, Radio } from 'lucide-react';
import { BAD_QUALITY, BANDS, channelQuality, type EEGFrame } from './api';
import type { BridgeInfo, BridgeStatus, LiveEEG, RecordingProgress, RecordingResult, UsbControls } from './hooks';
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
        {live.source === 'usb' ? 'OpenBCI USB' : live.source === 'bridge' ? 'OpenBCI bridge' : 'cloud stream'} · {f.board ?? 'board'} ·{' '}
        {f.fs} Hz · {qualitySummary(f)} · auto-scaled per channel · measured
      </small>
    </div>
  );
}

/** "8/8 ok" or "6/8 ok · flat: C3 · railed: O2". */
export function qualitySummary(f: Pick<EEGFrame, 'quality' | 'channel_names'>): string {
  const q = channelQuality(f);
  if (!q.length) return 'unverified';
  const ok = q.filter((x) => x === 'ok').length;
  const bad: Record<string, string[]> = {};
  q.forEach((x, i) => x !== 'ok' && (bad[x] ??= []).push(f.channel_names[i]));
  return [`${ok}/${q.length} ok`, ...Object.entries(bad).map(([k, v]) => `${k}: ${v.join(', ')}`)].join(' · ');
}

function RecordControls({
  recording,
  lastRecording,
  cloud,
  onRecord,
}: {
  recording: RecordingProgress | null;
  lastRecording: RecordingResult | null;
  cloud?: boolean;
  onRecord: (seconds: number, label: string) => void;
}) {
  const [label, setLabel] = useState('eyes closed');
  const [seconds, setSeconds] = useState(30);
  if (recording) {
    const pct = Math.min(100, (100 * recording.elapsed) / Math.max(1, recording.seconds));
    return (
      <div className="cx-record" role="status" aria-label="Recording progress">
        <span className="cx-rec-dot" /> Recording “{recording.label}” · {recording.elapsed.toFixed(0)}/
        {recording.seconds}s
        <div className="cx-progress">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="cx-record">
      <div className="cx-row">
        <input aria-label="Recording label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        <select aria-label="Recording seconds" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
          {[10, 20, 30, 45, 60].map((s) => (
            <option key={s} value={s}>
              {s}s
            </option>
          ))}
        </select>
        <button className="outline-button" onClick={() => onRecord(seconds, label.trim() || 'lab recording')}>
          <Circle size={11} /> Record
        </button>
      </div>
      {cloud === false && (
        <small className="cx-note warn">
          Bridge is not paired: recordings are saved locally only. Pair it below, then restart it with{' '}
          <code>--cloud</code> to investigate recordings here.
        </small>
      )}
      {lastRecording && (
        <small className={`cx-note ${lastRecording.recordingId ? '' : 'warn'}`}>
          {lastRecording.recordingId
            ? 'Recording uploaded — choose it under New experiment → OpenBCI.'
            : lastRecording.message || `Saved locally${lastRecording.path ? ` (${lastRecording.path})` : ''}; not uploaded.`}
        </small>
      )}
    </div>
  );
}

export function EEGPanel({
  bridge,
  live,
  onIngestToken,
  ingestToken,
  info,
  recording = null,
  lastRecording = null,
  bridgeError = '',
  onRecord,
  usb,
}: {
  usb?: UsbControls;
  bridge: BridgeStatus;
  live: LiveEEG;
  onIngestToken?: () => void;
  ingestToken?: string;
  info?: BridgeInfo | null;
  recording?: RecordingProgress | null;
  lastRecording?: RecordingResult | null;
  bridgeError?: string;
  onRecord?: (seconds: number, label: string) => void;
}) {
  const bands = averageBands(live.frame, live.buffer);
  const f = live.frame;
  const quality = f ? channelQuality(f) : [];
  const usbOn = usb?.state === 'streaming';
  const degraded = info && bridge === 'open' && info.state !== 'streaming' && info.state !== '';
  return (
    <section className="cx-section cx-eeg">
      <header className="cx-section-head">
        <h3>EEG sources</h3>
        <span className={`cx-live ${live.source !== 'none' ? 'on' : ''}`}>
          <Radio size={12} />{' '}
          {live.source === 'usb'
            ? 'USB live'
            : live.source === 'bridge'
            ? 'bridge live'
            : live.source === 'cloud'
              ? 'cloud live'
              : 'no signal'}
        </span>
      </header>
      <div className="cx-source">
        <span className={`status-dot ${usbOn || bridge === 'open' ? 'live' : ''}`} />
        <span>
          <strong>OpenBCI Cyton</strong>
          <small>
            {usbOn
              ? usb?.message || 'USB streaming'
              : usb?.state === 'connecting'
                ? usb.message || 'connecting…'
                : bridge === 'open'
                  ? 'local bridge connected'
                  : usb?.supported
                    ? 'plug in the USB dongle, switch the board to PC'
                    : 'use Chrome for USB headset'}
          </small>
        </span>
      </div>
      {usb?.supported && (
        <div className="cx-source-actions">
          {usbOn ? (
            <button className="outline-button" onClick={() => void usb.disconnect()}>
              Disconnect headset
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={usb.state === 'connecting'}
              onClick={() => void usb.connect()}
            >
              {usb.state === 'connecting' ? 'Connecting…' : 'Connect headset (USB)'}
            </button>
          )}
        </div>
      )}
      {usb?.state === 'error' && usb.message && <small className="cx-note warn">{usb.message}</small>}
      {degraded && (
        <div className="cx-banner" role="status">
          Bridge {info.state}
          {info.message ? `: ${info.message}` : '…'}
        </div>
      )}
      {bridgeError && <small className="cx-note warn">{bridgeError}</small>}
      {f?.alpha_state && f.alpha_state !== 'unknown' && (live.source === 'bridge' || live.source === 'usb') && (
        <div className={`cx-alpha ${f.alpha_state}`}>
          {f.alpha_state === 'eyes_closed' ? <EyeOff size={13} /> : <Eye size={13} />}
          {f.alpha_state === 'eyes_closed' ? 'eyes closed' : 'eyes open'}
          {typeof f.alpha_fraction === 'number' &&
            ` · alpha ${(100 * f.alpha_fraction).toFixed(0)}%${
              typeof f.alpha_baseline === 'number' ? ` (baseline ${(100 * f.alpha_baseline).toFixed(0)}%)` : ''
            }`}
        </div>
      )}
      {f && quality.length > 0 && (
        <div className="cx-quality" aria-label="Electrode quality">
          {f.channel_names.map((name, i) => {
            const mains = f.line_noise?.[i];
            const q = quality[i];
            return (
              <span
                key={name + i}
                className={`cx-q ${BAD_QUALITY.has(q) ? 'bad' : q === 'ok' ? 'ok' : 'warn'}`}
                title={`${name}: ${q}${mains !== undefined ? ` · mains ${(100 * mains).toFixed(0)}% of 1–45 Hz power` : ''}`}
              >
                {name}
                {mains !== undefined && mains > 0.3 ? ' ⚡' : ''}
              </span>
            );
          })}
        </div>
      )}
      {bridge === 'open' && onRecord && (
        <RecordControls recording={recording} lastRecording={lastRecording} cloud={info?.cloud} onRecord={onRecord} />
      )}
      {bridge !== 'open' && !usb?.supported && (
        <p className="cx-help">
          Start it next to the headset:
          <code>
            python research/bridge/openbci.py --board cyton --serial-port /dev/tty.usbserial-…
          </code>
          or <code>--board synthetic</code> to test without hardware.
        </p>
      )}
      {onIngestToken && !usb?.supported && (
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
            <Eye size={11} /> blinks detected: {f?.blink_count ?? live.blinkCount} · relative power, all channels
          </small>
        </div>
      )}
    </section>
  );
}
