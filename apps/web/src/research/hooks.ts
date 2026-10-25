import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CytonUSB, webSerialSupported, type UsbState } from './webserial';
import { ApiError, CortexClient, type EEGFrame, type LabConfig, type Me } from './api';

const TOKEN_KEY = 'cortex2.idtoken';
const read = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v) sessionStorage.setItem(k, v);
    else sessionStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
};

type GoogleId = {
  accounts: {
    id: {
      initialize: (o: {
        client_id: string;
        callback: (r: { credential: string }) => void;
        auto_select?: boolean;
      }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
      disableAutoSelect: () => void;
    };
  };
};

/** JWT `exp` (seconds) without verifying – only to drop an expired token early. */
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [token, setTokenState] = useState<string | null>(() => {
    const t = read(TOKEN_KEY);
    if (!t) return null;
    const exp = t === 'dev' ? null : tokenExpiry(t);
    return exp && exp * 1000 < Date.now() ? null : t;
  });
  const [me, setMe] = useState<Me | null>(null);
  const [authError, setAuthError] = useState('');
  const client = useMemo(() => new CortexClient(token), [token]);
  const setToken = useCallback((t: string | null) => {
    write(TOKEN_KEY, t);
    setTokenState(t);
  }, []);
  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    (window as unknown as { google?: GoogleId }).google?.accounts.id.disableAutoSelect();
  }, [setToken]);

  useEffect(() => {
    let alive = true;
    new CortexClient(null)
      .config()
      .then((c) => alive && (setConfig(c), setConfigError('')))
      .catch((e) => alive && setConfigError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    client
      .me()
      .then((m) => alive && (setMe(m), setAuthError('')))
      .catch((e) => {
        if (!alive) return;
        setAuthError(
          e instanceof ApiError && e.status === 401
            ? 'Sign-in was not accepted. Try again.'
            : String(e.message || e),
        );
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setToken(null);
      });
    return () => {
      alive = false;
    };
  }, [client, token, setToken]);

  // Expire the Google ID token (≈1h) proactively.
  useEffect(() => {
    if (!token || token === 'dev') return;
    const exp = tokenExpiry(token);
    if (!exp) return;
    const t = window.setTimeout(
      () => {
        setToken(null);
        setAuthError('Your Google sign-in expired. Sign in again to continue.');
      },
      Math.max(0, exp * 1000 - Date.now() - 30_000),
    );
    return () => window.clearTimeout(t);
  }, [token, setToken]);

  const signInDev = useCallback(() => setToken('dev'), [setToken]);
  // Stable identity: callers put this in effect dependency lists.
  const onUnauthorized = useCallback(() => {
    setToken(null);
    setAuthError('Your sign-in expired. Sign in again.');
  }, [setToken]);

  /** Renders the Google button into `host` (script is only loaded when a client id is configured). */
  const mountGoogle = useCallback(
    (host: HTMLElement | null) => {
      const id = config?.auth.google_client_id;
      if (!host || !id || token) return;
      const render = () => {
        const google = (window as unknown as { google?: GoogleId }).google;
        if (!google) return;
        google.accounts.id.initialize({ client_id: id, callback: (r) => setToken(r.credential) });
        host.replaceChildren();
        google.accounts.id.renderButton(host, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
        });
      };
      if ((window as unknown as { google?: GoogleId }).google) return render();
      let script = document.querySelector<HTMLScriptElement>('script[data-gsi]');
      if (!script) {
        script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.dataset.gsi = '1';
        script.onerror = () =>
          setAuthError('Google sign-in could not load (network or content blocker).');
        document.head.appendChild(script);
      }
      script.addEventListener('load', render, { once: true });
    },
    [config, token, setToken],
  );

  return {
    config,
    configError,
    token,
    me,
    client,
    authError,
    setAuthError,
    signInDev,
    signOut,
    mountGoogle,
    onUnauthorized,
  };
}

/** Run `fn` now and every `ms` while the tab is visible. */
export function usePoll(
  fn: (signal: AbortSignal) => Promise<void> | void,
  ms: number,
  deps: unknown[],
  enabled = true,
) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    let stopped = false;
    let controller = new AbortController();
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        controller = new AbortController();
        try {
          await ref.current(controller.signal);
        } catch {
          /* surfaced by the callee */
        }
      }
      if (!stopped) timer = window.setTimeout(tick, ms);
    };
    void tick();
    const vis = () => {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', vis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, enabled, ...deps]);
}

export type UsbControls = ReturnType<typeof useBridge>['usb'];
export type BridgeStatus = 'connecting' | 'open' | 'closed' | 'unsupported';
export const BRIDGE_URL = 'ws://127.0.0.1:8765';
const RING_SECONDS = 6;

export interface LiveEEG {
  source: 'usb' | 'bridge' | 'cloud' | 'none';
  frame: EEGFrame | null;
  /** Rolling buffer per channel (last ~6 s) for traces. */
  buffer: number[][];
  blinkCount: number;
  lastUpdate: number;
}

/** Append new per-channel samples to a ring buffer of `max` samples. */
export function appendRing(buffer: number[][], incoming: number[][], max: number): number[][] {
  return incoming.map((samples, i) => {
    const prev = buffer[i] ?? [];
    const next =
      prev.length + samples.length > max
        ? prev.slice(prev.length + samples.length - max)
        : prev.slice();
    for (const s of samples) next.push(Number.isFinite(s) ? s : 0);
    return next.slice(-max);
  });
}

/** Bridge-reported state (protocol v2 `hello`/`status`), separate from the socket state. */
export interface BridgeInfo {
  protocol: number;
  state: string; // connecting | streaming | reconnecting | stopped
  message: string;
  board?: string;
  serialPort?: string;
  /** Bridge can upload recordings (started with --cloud and a device token). */
  cloud?: boolean;
}
export interface RecordingProgress {
  label: string;
  seconds: number;
  elapsed: number;
}
export interface RecordingResult {
  recordingId: string | null;
  path?: string;
  message: string;
  at: number;
}

/** Count blinks from v2 `blink_count` deltas (robust to dropped frames); fall back to v1 `blink`. */
export function blinkDelta(prevCount: number | null, frame: Pick<EEGFrame, 'blink' | 'blink_count'>) {
  if (typeof frame.blink_count === 'number') {
    if (prevCount === null || frame.blink_count < prevCount) return { delta: 0, count: frame.blink_count };
    return { delta: Math.min(5, frame.blink_count - prevCount), count: frame.blink_count };
  }
  return { delta: frame.blink ? 1 : 0, count: prevCount };
}

/** Local OpenBCI bridge WebSocket with exponential reconnect; falls back to the cloud stream. */
export function useBridge(client: CortexClient | null, cloudEnabled: boolean) {
  const [status, setStatus] = useState<BridgeStatus>('connecting');
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const [recording, setRecording] = useState<RecordingProgress | null>(null);
  const [lastRecording, setLastRecording] = useState<RecordingResult | null>(null);
  const [bridgeError, setBridgeError] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const blinkCountRef = useRef<number | null>(null);
  const lastCloudFrame = useRef('');
  const [live, setLive] = useState<LiveEEG>({
    source: 'none',
    frame: null,
    buffer: [],
    blinkCount: 0,
    lastUpdate: 0,
  });
  const bufferRef = useRef<number[][]>([]);
  const blinkRef = useRef(0);
  const lastBridge = useRef(0);
  const usbRef = useRef<CytonUSB | null>(null);
  const [usbState, setUsbState] = useState<UsbState>('idle');
  const [usbMessage, setUsbMessage] = useState('');
  useEffect(() => {
    if (typeof WebSocket === 'undefined') {
      setStatus('unsupported');
      return;
    }
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer = 0;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      try {
        ws = new WebSocket(BRIDGE_URL);
      } catch {
        setStatus('closed');
        timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
        return;
      }
      ws.onopen = () => {
        retry = 0;
        blinkCountRef.current = null;
        wsRef.current = ws;
        setStatus('open');
        setBridgeError('');
      };
      ws.onmessage = (event) => {
        let msg: (EEGFrame & { type?: string; [k: string]: unknown }) | null = null;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!msg) return;
        const str = (k: string) => (typeof msg![k] === 'string' ? (msg![k] as string) : '');
        if (msg.type === 'hello' || msg.type === 'status') {
          setInfo((prev) => ({
            protocol: Number(msg.protocol ?? (msg.type === 'status' ? 2 : 1)),
            state: str('state') || 'streaming',
            message: str('message'),
            board: str('board') || undefined,
            serialPort: str('serial_port') || undefined,
            cloud: msg.type === 'hello' ? msg.cloud === true : prev?.cloud,
          }));
          return;
        }
        if (msg.type === 'recording_progress') {
          setRecording({ label: str('label'), seconds: Number(msg.seconds) || 0, elapsed: Number(msg.elapsed) || 0 });
          return;
        }
        if (msg.type === 'recording') {
          setRecording(null);
          setLastRecording({
            recordingId: (msg.recording_id as string | null) ?? null,
            path: str('path') || undefined,
            message: str('message'),
            at: Date.now(),
          });
          return;
        }
        if (msg.type === 'error') {
          setRecording(null);
          setBridgeError(str('message') || 'bridge error');
          return;
        }
        if (msg.type !== 'frame' || !Array.isArray(msg.samples)) return;
        if (usbRef.current) return; // USB headset takes priority over the legacy bridge
        if (msg.recording) setRecording(msg.recording);
        const fs = msg.fs || 250;
        if (bufferRef.current.length !== msg.samples.length) bufferRef.current = [];
        bufferRef.current = appendRing(
          bufferRef.current,
          msg.samples,
          Math.round(fs * RING_SECONDS),
        );
        const b = blinkDelta(blinkCountRef.current, msg);
        blinkCountRef.current = b.count;
        blinkRef.current += b.delta;
        lastBridge.current = Date.now();
        setLive({
          source: 'bridge',
          frame: msg,
          buffer: bufferRef.current,
          blinkCount: blinkRef.current,
          lastUpdate: Date.now(),
        });
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        setRecording(null);
        setStatus('closed');
        if (!stopped) timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  usePoll(
    async (signal) => {
      if (!client || usbRef.current || Date.now() - lastBridge.current < 3000) return;
      const r = await client.eegLatest(signal);
      if (!r.live || !r.frame) {
        setLive((l) => (l.source === 'cloud' ? { ...l, source: 'none', frame: null } : l));
        return;
      }
      const f = r.frame as EEGFrame & { updated_at?: string };
      // The cloud keeps only the latest frame; skip re-reads of the same one (no duplicate samples/blinks).
      if (f.updated_at && f.updated_at === lastCloudFrame.current) return;
      lastCloudFrame.current = f.updated_at ?? '';
      if (bufferRef.current.length !== f.samples.length) bufferRef.current = [];
      bufferRef.current = appendRing(
        bufferRef.current,
        f.samples,
        Math.round((f.fs || 250) * RING_SECONDS),
      );
      if (f.blink) blinkRef.current += 1;
      setLive({
        source: 'cloud',
        frame: f,
        buffer: bufferRef.current,
        blinkCount: blinkRef.current,
        lastUpdate: Date.now(),
      });
    },
    500,
    [client],
    cloudEnabled && !!client && status !== 'open',
  );

  // Bridge went quiet → drop to "none" so the UI does not show stale data as live.
  useEffect(() => {
    const t = window.setInterval(() => {
      setLive((l) =>
        l.source !== 'none' && Date.now() - l.lastUpdate > 5000
          ? { ...l, source: 'none', frame: null }
          : l,
      );
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  /** Connect the OpenBCI Cyton dongle directly over Web Serial (Chrome/Edge). */
  const connectUsb = useCallback(async () => {
    if (usbRef.current) return;
    const blinkBase = { count: null as number | null };
    const usb = new CytonUSB({
      onState: (st, message) => {
        setUsbState(st);
        setUsbMessage(message);
      },
      onFrame: (frame) => {
        if (usbRef.current !== usb) return;
        if (bufferRef.current.length !== frame.samples.length) bufferRef.current = [];
        bufferRef.current = appendRing(bufferRef.current, frame.samples, Math.round(frame.fs * RING_SECONDS));
        const b = blinkDelta(blinkBase.count, frame);
        blinkBase.count = b.count;
        blinkRef.current += b.delta;
        lastBridge.current = Date.now();
        setLive({
          source: 'usb',
          frame,
          buffer: bufferRef.current,
          blinkCount: blinkRef.current,
          lastUpdate: Date.now(),
        });
      },
    });
    usbRef.current = usb;
    setBridgeError('');
    try {
      await usb.start();
    } catch (e) {
      usbRef.current = null;
      await usb.stop().catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      // user closed the port chooser → not an error
      if (!/no port selected|NotFoundError/i.test(msg)) {
        setUsbState('error');
        setUsbMessage(msg);
      } else setUsbState('idle');
    }
  }, []);
  const disconnectUsb = useCallback(async () => {
    const usb = usbRef.current;
    usbRef.current = null;
    setRecording(null);
    await usb?.stop();
    setLive((l) => (l.source === 'usb' ? { ...l, source: 'none', frame: null } : l));
  }, []);
  useEffect(() => () => void usbRef.current?.stop(), []);

  /** Record `seconds` (4–60) of EEG and upload it; progress arrives via `recording`. */
  const record = useCallback(
    (seconds: number, label: string) => {
      const s = Math.min(60, Math.max(4, Math.round(seconds)));
      const name = label.slice(0, 120) || 'lab recording';
      const usb = usbRef.current;
      if (usb) {
        setBridgeError('');
        const start = usb.samplesTotal;
        setRecording({ label: name, seconds: s, elapsed: 0 });
        const tick = window.setInterval(() => {
          const cur = usbRef.current;
          if (cur !== usb) {
            window.clearInterval(tick);
            setRecording(null);
            setBridgeError('USB headset disconnected during recording.');
            return;
          }
          const elapsed = Math.min(s, (usb.samplesTotal - start) / 250);
          setRecording({ label: name, seconds: s, elapsed });
          if (elapsed < s) return;
          window.clearInterval(tick);
          const payload = usb.snapshot(s, name);
          setRecording(null);
          void (async () => {
            if (!client) {
              setLastRecording({ recordingId: null, message: 'Sign in to upload recordings.', at: Date.now() });
              return;
            }
            try {
              const { token } = await client.post<{ token: string }>('/v1/eeg/ingest-token');
              const device = new CortexClient(token, client.base);
              const r = await device.post<{ recording_id: string }>('/v1/eeg/recordings', payload);
              setLastRecording({ recordingId: r.recording_id, message: `uploaded as ${r.recording_id}`, at: Date.now() });
            } catch (e) {
              setLastRecording({
                recordingId: null,
                message: `Upload failed: ${e instanceof Error ? e.message : e}`,
                at: Date.now(),
              });
            }
          })();
        }, 500);
        return true;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setBridgeError('Connect the headset (USB) first.');
        return false;
      }
      setBridgeError('');
      ws.send(JSON.stringify({ type: 'record', seconds: s, label: name }));
      setRecording({ label, seconds: s, elapsed: 0 });
      return true;
    },
    [client],
  );

  const usb = {
    supported: webSerialSupported(),
    state: usbState,
    message: usbMessage,
    connect: connectUsb,
    disconnect: disconnectUsb,
  };
  const effectiveStatus: BridgeStatus = usbState === 'streaming' ? 'open' : status;
  const effectiveInfo: BridgeInfo | null =
    usbState === 'streaming' ? { protocol: 2, state: 'streaming', message: usbMessage, board: 'cyton-usb', cloud: !!client } : info;

  return { status: effectiveStatus, live, info: effectiveInfo, recording, lastRecording, bridgeError, record, usb };
}

export function useCompact() {
  const [compact, setCompact] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 900px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const changed = () => setCompact(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return compact;
}
