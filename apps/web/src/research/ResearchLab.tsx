import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { BrainScene, type ResearchMood } from '@little-brain/brain';
import {
  ArrowUp,
  Atom,
  Brain,
  FlaskConical,
  Layers,
  LogOut,
  MessageCircle,
  PanelLeft,
  Plus,
  Sparkles,
  Waves,
} from 'lucide-react';
import { IconButton } from '../components';
import { WorkspacePane } from '../WorkspacePane';
import {
  ApiError,
  isActive,
  type Dataset,
  type Experiment,
  type ExperimentDetail,
  type FeedItem,
  type Job,
  type JobRequest,
  type NewExperiment,
  type Recording,
  type Session,
  type SyntheticPreset,
} from './api';
import {
  DEFAULT_RUN,
  ExperimentTab,
  FeedTab,
  JobTab,
  toJobRequest,
  type RunSettings,
} from './Analysis';
import { AgentTimeline } from './AgentTimeline';
import { EEGPanel, TraceStrip } from './EEGPanel';
import { useAuth, useBridge, useCompact, usePoll } from './hooks';
import { JobsPanel } from './JobsPanel';
import { QuantumViz } from './QuantumViz';
import { anchorsFromEEG, idleAnchors, rms } from './signal';
import './lab.css';

type Tab = 'experiment' | 'job' | 'agent' | 'feed';

function LabComposer({
  onSend,
  disabled,
  placeholder,
  compact,
}: {
  onSend: (text: string) => Promise<boolean>;
  disabled: boolean;
  placeholder: string;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || disabled || sending) return;
    const text = draft;
    setDraft('');
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (!ok) setDraft(text);
  };
  return (
    <form className={`composer ${compact ? 'compact' : ''}`} onSubmit={submit}>
      {!compact && (
        <div className="composer-spark">
          <Sparkles size={19} />
        </div>
      )}
      <textarea
        aria-label="Message the research agent"
        placeholder={placeholder}
        value={draft}
        maxLength={4000}
        rows={1}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-actions">
        <button
          className="send-button"
          type="submit"
          aria-label="Send to agent"
          disabled={!draft.trim() || disabled || sending}
        >
          <ArrowUp size={19} />
        </button>
      </div>
    </form>
  );
}

function NewExperimentForm({
  presets,
  datasets,
  recordings,
  onCreate,
  busy,
}: {
  presets: SyntheticPreset[];
  datasets: Dataset[];
  recordings: Recording[];
  onCreate: (body: NewExperiment) => void;
  busy: boolean;
}) {
  const [kind, setKind] = useState<'synthetic' | 'recording' | 'openbci'>('synthetic');
  const [preset, setPreset] = useState('');
  const [dataset, setDataset] = useState('');
  const [channel, setChannel] = useState('');
  const [segment, setSegment] = useState('ictal');
  const [recording, setRecording] = useState('');
  const [recChannel, setRecChannel] = useState('');
  const rec = recordings.find((r) => r.id === recording);
  useEffect(() => {
    // Default to an occipital electrode (eyes-closed alpha), else the first channel.
    if (rec && !rec.channel_names.includes(recChannel))
      setRecChannel(rec.channel_names.find((c) => /^O[12z]$/i.test(c)) ?? rec.channel_names[0] ?? '');
  }, [rec, recChannel]);
  const ds = datasets.find((d) => d.id === dataset) ?? datasets[0];
  useEffect(() => {
    if (ds && !ds.channels.includes(channel)) setChannel(ds.channels[0] ?? '');
    if (ds && !ds.segments.includes(segment)) setSegment(ds.segments[0] ?? '');
  }, [ds, channel, segment]);
  return (
    <div className="cx-new">
      <div className="cx-segmented" role="tablist" aria-label="Experiment source">
        {(['synthetic', 'recording', 'openbci'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? 'selected' : ''}
            onClick={() => setKind(k)}
          >
            {k === 'synthetic' ? 'Synthetic' : k === 'recording' ? 'Seizure EEG' : 'OpenBCI'}
          </button>
        ))}
      </div>
      {kind === 'synthetic' && (
        <>
          <select
            aria-label="Hidden configuration"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            <option value="">random hidden configuration</option>
            {presets.map((p) => (
              <option key={p.bitstring} value={p.bitstring}>
                {p.label} ({p.bitstring})
              </option>
            ))}
          </select>
          <small>Known ground truth → measures whether the search recovers it.</small>
          <button
            className="primary-button cx-primary"
            disabled={busy}
            onClick={() =>
              onCreate(
                preset
                  ? { source: 'synthetic', truth_bitstring: preset }
                  : { source: 'synthetic', random_seed: Math.floor(Math.random() * 1e6) },
              )
            }
          >
            <Plus size={14} /> New synthetic brain
          </button>
        </>
      )}
      {kind === 'recording' &&
        (datasets.length ? (
          <>
            <select
              aria-label="Dataset"
              value={ds?.id ?? ''}
              onChange={(e) => setDataset(e.target.value)}
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <div className="cx-row">
              <select
                aria-label="Channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                {ds?.channels.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <select
                aria-label="Segment"
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
              >
                {ds?.segments.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <small>Real data → consistent model configurations, not validated causes.</small>
            <button
              className="primary-button cx-primary"
              disabled={busy || !ds}
              onClick={() =>
                ds && onCreate({ source: 'recording', dataset_id: ds.id, channel, segment })
              }
            >
              <Plus size={14} /> Investigate excerpt
            </button>
          </>
        ) : (
          <small>No recorded datasets on the server.</small>
        ))}
      {kind === 'openbci' &&
        (recordings.length ? (
          <>
            <select
              aria-label="Recording"
              value={recording}
              onChange={(e) => setRecording(e.target.value)}
            >
              <option value="">choose a recording</option>
              {recordings.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {r.seconds.toFixed(0)}s ·{' '}
                  {new Date(r.created_at).toLocaleTimeString()}
                </option>
              ))}
            </select>
            {rec && (
              <select
                aria-label="Recording channel"
                value={recChannel}
                onChange={(e) => setRecChannel(e.target.value)}
              >
                {rec.channel_names.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            )}
            <button
              className="primary-button cx-primary"
              disabled={busy || !recording}
              onClick={() =>
                onCreate({ source: 'openbci', recording_id: recording, channel: recChannel || undefined })
              }
            >
              <Plus size={14} /> Investigate my recording
            </button>
          </>
        ) : (
          <small>
            Record with the bridge:{' '}
            <code>python research/bridge/openbci.py --record 30 --label "eyes closed"</code>
          </small>
        ))}
    </div>
  );
}

export default function ResearchLab() {
  const auth = useAuth();
  const { client, config, me, token } = auth;
  const compact = useCompact();
  const [leftOpen, setLeftOpen] = useState(() => !compact);
  const [rightOpen, setRightOpen] = useState(() => !compact);
  const [leftWidth, setLeftWidth] = useState(286);
  const [rightWidth, setRightWidth] = useState(420);
  const [tab, setTab] = useState<Tab>('experiment');
  const [inside, setInside] = useState(true);
  const [fibers, setFibers] = useState(true);
  const [showQuantum, setShowQuantum] = useState(true);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedExp, setSelectedExp] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [presets, setPresets] = useState<SyntheticPreset[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [run, setRun] = useState<RunSettings>(DEFAULT_RUN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmQpu, setConfirmQpu] = useState<'ibm_quantum' | 'ionq_qpu' | 'qbraid_qpu' | null>(null);
  const [ingestToken, setIngestToken] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [mood, setMood] = useState<ResearchMood>('idle');
  const [phase, setPhase] = useState(0);
  const lastFrame = useRef<HTMLCanvasElement | null>(null);
  const googleHost = useRef<HTMLDivElement>(null);
  const signedIn = !!me && !!token;
  const bridge = useBridge(signedIn ? client : null, signedIn);
  const { status: bridgeStatus, live } = bridge;

  const { onUnauthorized } = auth;
  // Must keep a stable identity: it is a dependency of the bootstrap effect below.
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      setError(e instanceof Error ? e.message : String(e));
    },
    [onUnauthorized],
  );

  useEffect(() => {
    auth.mountGoogle(googleHost.current);
  }, [auth.mountGoogle, signedIn]);

  // Keyboard: Cmd/Ctrl+\ toggles the analysis pane, Escape closes overlays (as in the original app).
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConfirmQpu(null);
        if (compact) setRightOpen(false);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault();
        setRightOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [compact]);

  useEffect(() => {
    if (!signedIn) return;
    client
      .datasets()
      .then((d) => (setDatasets(d.datasets), setPresets(d.synthetic_presets)))
      .catch(fail);
    client.session().then(setSession).catch(fail);
    client
      .recordings()
      .then((r) => setRecordings(r.recordings))
      .catch(() => {});
  }, [client, signedIn, fail]);

  usePoll(
    async () => {
      const [e, j] = await Promise.all([client.experiments(), client.jobs()]);
      setExperiments(e.experiments);
      setJobs(j.jobs);
      setSelectedExp((s) => s ?? e.experiments[0]?.id ?? null);
    },
    2500,
    [client],
    signedIn,
  );
  usePoll(
    async (signal) => {
      if (!selectedExp) return setDetail(null);
      const d = await client.experiment(selectedExp, signal);
      setDetail(d);
    },
    2500,
    [client, selectedExp],
    signedIn && !!selectedExp,
  );
  usePoll(
    async () => {
      const f = await client.feed(null);
      setFeed(f.items);
    },
    3000,
    [client],
    signedIn,
  );
  usePoll(
    async () => {
      setSession(await client.session());
    },
    10000,
    [client],
    signedIn,
  );

  const selectedJob = useMemo(
    () =>
      jobs.find((j) => j.id === selectedJobId) ??
      detail?.jobs.find((j) => j.id === selectedJobId) ??
      null,
    [jobs, detail, selectedJobId],
  );
  const stageJob = useMemo(() => {
    if (selectedJob?.kind === 'sample') return selectedJob;
    const pool = (detail?.jobs ?? jobs).filter((j) => j.kind === 'sample');
    return pool.find(isActive) ?? pool[0] ?? null;
  }, [selectedJob, detail, jobs]);
  const anyActive = jobs.some(isActive);
  const exp = detail?.experiment ?? null;

  const alphaState = live.source === 'bridge' ? live.frame?.alpha_state : undefined;
  // Cute reactions, driven by real events.
  const prevVerdicts = useRef<string>('');
  const prevCompleted = useRef<Set<string>>(new Set());
  useEffect(() => {
    const improved = (detail?.revisions ?? [])
      .filter((r) => r.verdict === 'improved')
      .map((r) => r.id)
      .join(',');
    const completedGood = jobs
      .filter((j) => j.status === 'completed' && j.evaluation?.best_consistent)
      .map((j) => j.id);
    const fresh = completedGood.filter((id) => !prevCompleted.current.has(id));
    const firstLoad =
      prevCompleted.current.size === 0 && completedGood.length > 0 && !prevVerdicts.current;
    let next: ResearchMood = anyActive
      ? 'curious'
      : alphaState === 'eyes_closed'
        ? 'sleepy'
        : live.source !== 'none'
        ? 'idle'
        : experiments.length
          ? 'idle'
          : 'sleepy';
    if (
      !firstLoad &&
      ((improved && improved !== prevVerdicts.current && prevVerdicts.current !== '') ||
        fresh.length)
    )
      next = 'happy';
    prevVerdicts.current = improved || prevVerdicts.current || '-';
    completedGood.forEach((id) => prevCompleted.current.add(id));
    setMood(next);
    if (next === 'happy') {
      const t = window.setTimeout(() => setMood(anyActive ? 'curious' : 'idle'), 3500);
      return () => window.clearTimeout(t);
    }
  }, [detail?.revisions, jobs, anyActive, live.source, experiments.length, alphaState]);
  // Seizure excerpt or high-amplitude burst → surprised for a moment.
  const lastRms = useRef(0);
  useEffect(() => {
    const seizure =
      exp?.target.source === 'recording' && String(exp.target.meta?.segment ?? '') === 'ictal';
    if (seizure) {
      setMood('surprised');
      const t = window.setTimeout(() => setMood('idle'), 2600);
      return () => window.clearTimeout(t);
    }
  }, [exp?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live.frame) return;
    const r = rms(live.buffer[0]?.slice(-Math.round(live.frame.fs * 0.5)) ?? []);
    if (lastRms.current && r > lastRms.current * 3.5) {
      setMood('surprised');
      window.setTimeout(() => setMood('idle'), 1600);
    }
    lastRms.current = lastRms.current ? lastRms.current * 0.95 + r * 0.05 : r;
  }, [live]);

  // Eyes closed (bridge alpha detector) → relaxed, half-lidded brain; reopening → awake again.
  const prevAlpha = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (alphaState === prevAlpha.current) return;
    if (alphaState === 'eyes_closed') setMood('sleepy');
    else if (prevAlpha.current === 'eyes_closed') setMood(anyActive ? 'curious' : 'idle');
    prevAlpha.current = alphaState;
  }, [alphaState, anyActive]);

  // A finished bridge recording that was uploaded becomes selectable as an OpenBCI experiment.
  useEffect(() => {
    const r = bridge.lastRecording;
    if (!r || !signedIn) return;
    if (r.recordingId) {
      client
        .recordings()
        .then((x) => setRecordings(x.recordings))
        .catch(() => {});
      setNotice('Recording uploaded — New experiment → OpenBCI to investigate it.');
    }
  }, [bridge.lastRecording, client, signedIn]);

  useEffect(() => {
    if (live.frame) return;
    const t = window.setInterval(() => setPhase((p) => p + 1), 120);
    return () => window.clearInterval(t);
  }, [live.frame]);

  const anchors = useMemo(
    () => (live.frame ? anchorsFromEEG(live.frame, live.buffer) : idleAnchors(phase * 0.12)),
    [live, phase],
  );
  const overlay = useMemo(
    () => ({
      intensities: fibers ? anchors.intensities : anchors.intensities.map(() => 0),
      labels: anchors.labels,
      values: anchors.values,
      opacity: fibers ? 0.9 : 0,
      shellOpacity: inside ? 0.2 : 0.62,
      mood,
      blinkSignal: live.blinkCount,
      gaze: null,
    }),
    [anchors, fibers, inside, mood, live.blinkCount],
  );

  const createExperiment = async (body: NewExperiment) => {
    setBusy(true);
    setError('');
    try {
      const { experiment } = await client.createExperiment(body);
      setExperiments((e) => [experiment, ...e.filter((x) => x.id !== experiment.id)]);
      setSelectedExp(experiment.id);
      setTab('experiment');
      setNewOpen(false);
      if (!rightOpen) setRightOpen(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  /** Agent-driven EEG triage: OpenBCI recording if one is selected, else the CHB-MIT seizure window. */
  const triage = async () => {
    setBusy(true);
    setError('');
    try {
      const meta = (exp?.target.meta ?? {}) as Record<string, unknown>;
      const body =
        exp?.target.source === 'openbci' && typeof meta.recording_id === 'string'
          ? { recording_id: meta.recording_id }
          : { dataset_id: datasets[0]?.id ?? 'chbmit-chb01_03', start: 2960, end: 3060 };
      const { item, job } = await client.triage(body);
      setFeed((f) => [item, ...f]);
      if (job) setJobs((j) => [job, ...j.filter((x) => x.id !== job.id)]);
      setTab('feed');
      if (!rightOpen) setRightOpen(true);
      setNotice('EEG triage started — the agent is reading the spectrograms.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const runJob = async (req: JobRequest) => {
    if (!exp) return;
    setBusy(true);
    setError('');
    try {
      const { job } = await client.createJob(exp.id, req);
      setJobs((j) => [job, ...j]);
      setSelectedJobId(job.id);
      setNotice(`${job.provider} queued`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const sendSnapshot = async () => {
    if (!exp || !lastFrame.current) return;
    try {
      await client.snapshot(exp.id, lastFrame.current.toDataURL('image/png'));
    } catch {
      /* the agent still receives numeric diagnostics */
    }
  };
  const iterate = async (instruction?: string) => {
    if (!exp) return;
    setBusy(true);
    try {
      await sendSnapshot();
      const { job } = await client.iterate(exp.id, instruction);
      setJobs((j) => [job, ...j]);
      setTab('agent');
      setNotice('Agent iteration started');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const compareProviders = async () => {
    if (!exp) return;
    const available = new Set(
      (config?.providers ?? []).filter((p) => p.available).map((p) => p.id),
    );
    for (const provider of ['random', 'classical_anneal', 'thrml', 'aer_noisy'] as const)
      if (!config || available.has(provider))
        await runJob(toJobRequest({ ...run, provider }, exp.baseline));
    setTab('experiment');
  };
  const sendMessage = async (text: string) => {
    try {
      const { item, job } = await client.message(text, exp?.id);
      setFeed((f) => [item, ...f]);
      setJobs((j) => [job, ...j]);
      setTab('feed');
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const updateSession = async (patch: Partial<Session>) => {
    setSession((s) => (s ? { ...s, ...patch } : s));
    try {
      setSession(await client.updateSession(patch));
    } catch (e) {
      fail(e);
    }
  };
  const ibmProvider = config?.providers.find((p) => p.id === 'ibm_quantum');
  const ionqProvider = config?.providers.find((p) => p.id === 'ionq_qpu');
  const qbraidProvider = config?.providers.find((p) => p.id === 'qbraid_qpu');
  const truth = exp?.target.truth_bitstring ?? null;
  const status = !signedIn
    ? 'signed out'
    : anyActive
      ? `${jobs.filter(isActive).length} job${jobs.filter(isActive).length === 1 ? '' : 's'} running`
      : live.source !== 'none'
        ? 'listening to EEG'
        : 'ready';

  const quick = (
    <div className="cx-chips" role="toolbar" aria-label="Quick actions">
      <button disabled={!exp || busy} onClick={() => void iterate()}>
        <Sparkles size={13} /> Run iteration
      </button>
      <button
        disabled={!exp || busy}
        onClick={() => void runJob(toJobRequest({ ...run, provider: 'aer_noisy' }, exp?.baseline))}
      >
        <Atom size={13} /> Run on simulator
      </button>
      <button
        disabled={!exp || busy || !ibmProvider?.available}
        title={
          ibmProvider?.available ? undefined : (ibmProvider?.reason ?? 'IBM Quantum not configured')
        }
        onClick={() => setConfirmQpu('ibm_quantum')}
      >
        <Atom size={13} /> Submit to IBM
      </button>
      <button
        disabled={!exp || busy || !ionqProvider?.available}
        title={ionqProvider?.available ? undefined : (ionqProvider?.reason ?? 'IonQ not configured')}
        onClick={() => setConfirmQpu('ionq_qpu')}
      >
        <Atom size={13} /> Submit to IonQ
      </button>
      <button
        disabled={!exp || busy || !qbraidProvider?.available}
        title={qbraidProvider?.available ? (qbraidProvider.reason ?? undefined) : (qbraidProvider?.reason ?? 'qBraid not configured')}
        onClick={() => setConfirmQpu('qbraid_qpu')}
      >
        <Atom size={13} /> Run on qBraid QPU
      </button>
      <button
        disabled={busy || !config?.agent_configured}
        title={
          config?.agent_configured
            ? 'The agent reads per-channel spectrograms, picks channels/windows and runs a quantum search on each'
            : 'No agent model configured on the server'
        }
        onClick={() => void triage()}
      >
        <Waves size={13} /> EEG triage
      </button>
      <button disabled={!exp || busy} onClick={() => void compareProviders()}>
        <Layers size={13} /> Compare providers
      </button>
    </div>
  );
  const qpuName = confirmQpu === 'ionq_qpu' ? 'IonQ' : confirmQpu === 'qbraid_qpu' ? 'qBraid' : 'IBM';
  const ibmConfirm = confirmQpu && exp && (
    <div className="cx-confirm" role="dialog" aria-label={`Confirm ${qpuName} submission`}>
      <p>
        Submit this circuit ({run.approximation}, reps {run.reps}, ≤{run.maxCouplings ?? 28}{' '}
        couplings, {run.shots} shots) to real {qpuName} quantum hardware?{' '}
        {confirmQpu === 'qbraid_qpu'
          ? `This bills qBraid credits and runs on the default device (${qbraidProvider?.reason ?? 'rigetti:rigetti:qpu:cepheus-1-108q'}); jobs may queue.`
          : confirmQpu === 'ionq_qpu'
          ? 'Trapped ions are all-to-all connected, so no SWAPs are added. QPU time is billed to your IonQ account and jobs may queue.'
          : 'It uses QPU time from the open plan (10 min / 28 days) and may wait in a queue.'}
      </p>
      <div>
        <button className="outline-button" onClick={() => setConfirmQpu(null)}>
          Cancel
        </button>
        <button
          className="primary-button cx-primary"
          onClick={() => {
            const provider = confirmQpu;
            setConfirmQpu(null);
            void runJob(toJobRequest({ ...run, provider }, exp.baseline));
          }}
        >
          Submit to {qpuName}
        </button>
      </div>
    </div>
  );
  const composer = (c?: boolean) => (
    <LabComposer
      compact={c}
      disabled={!signedIn}
      placeholder={
        signedIn
          ? exp
            ? 'Ask the agent to investigate, run, or babysit…'
            : 'Ask the research agent…'
          : 'Sign in to talk to the agent'
      }
      onSend={sendMessage}
    />
  );

  return (
    <div
      className="app simple-app cx-lab"
      style={{ '--chat-width': `${rightWidth}px` } as CSSProperties}
    >
      <main className="workspace">
        <header className="simple-header">
          <div className="workspace-brand">
            <IconButton
              label={leftOpen ? 'Hide laboratory pane' : 'Open laboratory pane'}
              active={leftOpen}
              onClick={() => (setLeftOpen((o) => !o), compact && setRightOpen(false))}
            >
              <PanelLeft size={19} />
            </IconButton>
            <span className="cute-logo">
              <Brain size={21} />
            </span>
            <span>
              cortex² <small className="cx-tagline">the quantum brain detective</small>
            </span>
          </div>
          <div className="focused-brain">
            <span className="twin-dot" style={{ background: anyActive ? '#f2b067' : '#9caf8d' }} />
            <strong>{exp?.title ?? 'No experiment'}</strong>
            <span className="brain-status" aria-live="polite">
              {status}
            </span>
          </div>
          <div className="simple-header-actions">
            <IconButton
              label={showQuantum ? 'Hide quantum view' : 'Show quantum view'}
              active={showQuantum}
              onClick={() => setShowQuantum((v) => !v)}
            >
              <Atom size={17} />
            </IconButton>
            <button
              className={`chat-toggle ${rightOpen ? 'active' : ''}`}
              aria-label={rightOpen ? 'Close analysis' : 'Open analysis'}
              onClick={() => (setRightOpen((o) => !o), compact && setLeftOpen(false))}
            >
              <FlaskConical size={18} />
              <span>Analysis</span>
            </button>
          </div>
        </header>
        <div className="workspace-body">
          {leftOpen && (
            <WorkspacePane
              side="left"
              title="Laboratory"
              width={leftWidth}
              onResize={setLeftWidth}
              onClose={() => setLeftOpen(false)}
              actions={
                signedIn ? (
                  <IconButton
                    label="New experiment"
                    onClick={() => setNewOpen((o) => !o)}
                    active={newOpen}
                  >
                    <Plus size={17} />
                  </IconButton>
                ) : undefined
              }
            >
              <div className="cx-left-scroll">
                <section className="cx-section cx-account">
                  {signedIn ? (
                    <div className="cx-me">
                      {me?.picture ? (
                        <img src={me.picture} alt="" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="pane-brain-avatar">
                          <Brain size={20} />
                        </span>
                      )}
                      <span>
                        <strong>{me?.name || me?.email || 'Signed in'}</strong>
                        <small>{me?.email}</small>
                      </span>
                      <IconButton label="Sign out" onClick={auth.signOut}>
                        <LogOut size={15} />
                      </IconButton>
                    </div>
                  ) : (
                    <div className="cx-signin">
                      <strong>Sign in to run experiments</strong>
                      <small>
                        Jobs, recordings and agent sessions are stored per Google account.
                      </small>
                      <div ref={googleHost} className="cx-google" />
                      {config?.auth.dev_auth && (
                        <button className="outline-button" onClick={auth.signInDev}>
                          Continue as dev (local only)
                        </button>
                      )}
                      {config && !config.auth.google_client_id && !config.auth.dev_auth && (
                        <small className="cx-note warn">
                          Google sign-in is not configured on the server (GOOGLE_OAUTH_CLIENT_ID).
                        </small>
                      )}
                      {auth.configError && (
                        <small className="cx-note warn">
                          {auth.configError === 'The research service is unreachable.'
                            ? 'The research service is unreachable. Start it (uvicorn) or set VITE_CORTEX_API.'
                            : `Research service: ${auth.configError}`}
                        </small>
                      )}
                      {auth.authError && <small className="cx-note warn">{auth.authError}</small>}
                    </div>
                  )}
                </section>
                {signedIn && newOpen && (
                  <section className="cx-section">
                    <header className="cx-section-head">
                      <h3>New experiment</h3>
                    </header>
                    <NewExperimentForm
                      presets={presets}
                      datasets={datasets}
                      recordings={recordings}
                      onCreate={createExperiment}
                      busy={busy}
                    />
                  </section>
                )}
                {signedIn && (
                  <section className="cx-section">
                    <header className="cx-section-head">
                      <h3>Experiments</h3>
                      <span className="cx-count">{experiments.length}</span>
                    </header>
                    {!experiments.length ? (
                      <div className="cx-empty-line">
                        No experiments yet.{' '}
                        <button className="cx-link" onClick={() => setNewOpen(true)}>
                          Create one
                        </button>
                      </div>
                    ) : (
                      <div className="pane-brain-list cx-exp-list">
                        {experiments.map((e) => (
                          <button
                            key={e.id}
                            className={`pane-brain ${e.id === selectedExp ? 'selected' : ''}`}
                            aria-pressed={e.id === selectedExp}
                            onClick={() => (
                              setSelectedExp(e.id),
                              setTab('experiment'),
                              compact && setLeftOpen(false)
                            )}
                          >
                            <span
                              className="pane-brain-avatar"
                              style={{
                                background:
                                  e.target.source === 'synthetic'
                                    ? '#e4dff4'
                                    : e.target.source === 'recording'
                                      ? '#fae2ed'
                                      : '#d6eadf',
                              }}
                            >
                              {e.target.source === 'synthetic' ? (
                                <Sparkles size={18} />
                              ) : (
                                <Waves size={18} />
                              )}
                            </span>
                            <span>
                              <strong>{e.title}</strong>
                              <small>
                                {e.target.source} · {e.rounds ?? 0} rounds
                                {e.best ? ` · best ${e.best.nonlinear_loss.toFixed(3)}` : ''}
                              </small>
                            </span>
                            {e.id === selectedExp && <span className="selected-dot" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                <EEGPanel
                  bridge={bridgeStatus}
                  live={live}
                  info={bridge.info}
                  recording={bridge.recording}
                  lastRecording={bridge.lastRecording}
                  bridgeError={bridge.bridgeError}
                  onRecord={signedIn ? (sec, label) => void bridge.record(sec, label) : undefined}
                  ingestToken={ingestToken}
                  onIngestToken={
                    signedIn
                      ? () =>
                          client
                            .ingestToken()
                            .then((t) => setIngestToken(t.token))
                            .catch(fail)
                      : undefined
                  }
                />
                <JobsPanel
                  jobs={jobs}
                  selectedId={selectedJobId}
                  signedIn={signedIn}
                  onSelect={(j) => {
                    setSelectedJobId(j.id);
                    if (j.experiment_id && j.experiment_id !== selectedExp)
                      setSelectedExp(j.experiment_id);
                    setTab(
                      j.kind === 'agent_iteration'
                        ? 'agent'
                        : j.kind === 'agent_operator'
                          ? 'feed'
                          : 'job',
                    );
                    if (!rightOpen) setRightOpen(true);
                    if (compact) setLeftOpen(false);
                  }}
                  onCancel={(j) =>
                    client
                      .cancelJob(j.id)
                      .then(({ job }) =>
                        setJobs((all) => all.map((x) => (x.id === job.id ? job : x))),
                      )
                      .catch(fail)
                  }
                  session={session}
                  onSession={(p) => void updateSession(p)}
                />
              </div>
              <div className="pane-bottom">
                <a href="/" className="cx-bottom-link">
                  <Brain size={15} /> My Little Brain companion
                </a>
              </div>
            </WorkspacePane>
          )}
          <section className="main-content">
            <div
              className={`simple-habitat cx-habitat ${showQuantum && signedIn ? 'with-qviz' : ''}`}
            >
              <BrainScene
                thoughts={[]}
                activeThoughtId={null}
                thinking={anyActive}
                paused={false}
                showThoughts={false}
                onThoughtSelect={() => {}}
                anatomyMode={inside}
                researchOverlay={overlay}
                onFrame={signedIn && exp ? (c) => (lastFrame.current = c) : undefined}
              />
              <div className="cx-stage-note">
                {live.frame ? (
                  <>
                    <i className="status-dot live" /> markers: measured{' '}
                    {live.source === 'bridge' ? 'OpenBCI' : 'cloud'} EEG mapped to 10-20 sites (
                    {anchors.mapped}/19)
                  </>
                ) : (
                  <>markers: illustrative idle animation · no EEG streaming</>
                )}
                <br />
                fibers: illustrative anatomical overlay, not tractography reconstructed from scalp
                EEG
              </div>
              {live.frame && <TraceStrip live={live} />}
            </div>
            <div className="scene-options">
              <button
                className={inside ? 'selected' : ''}
                aria-pressed={inside}
                onClick={() => setInside((v) => !v)}
              >
                <Layers size={15} />
                <span>Inside</span>
              </button>
              <button
                className={fibers ? 'selected' : ''}
                aria-pressed={fibers}
                onClick={() => setFibers((v) => !v)}
              >
                <Waves size={15} />
                <span>Fibers</span>
              </button>
              <button
                className={showQuantum ? 'selected' : ''}
                aria-pressed={showQuantum}
                onClick={() => setShowQuantum((v) => !v)}
              >
                <Atom size={15} />
                <span>Quantum</span>
              </button>
            </div>
            {showQuantum && signedIn && (
              <QuantumViz
                job={stageJob}
                budget={config?.gate_budget ?? 130}
                truth={truth}
                onClose={() => setShowQuantum(false)}
              />
            )}
            {(error || notice) && (
              <div
                className={`connection-feedback cx-toast ${error ? 'error' : ''}`}
                role={error ? 'alert' : 'status'}
              >
                {error || notice}
                <button onClick={() => (setError(''), setNotice(''))}>Dismiss</button>
              </div>
            )}
            {!rightOpen && <div className="floating-compose">{composer()}</div>}
          </section>
          {rightOpen && (
            <WorkspacePane
              side="right"
              title="Analysis"
              width={rightWidth}
              onResize={setRightWidth}
              onClose={() => setRightOpen(false)}
              actions={
                <IconButton
                  label="Agent feed"
                  onClick={() => setTab('feed')}
                  active={tab === 'feed'}
                >
                  <MessageCircle size={16} />
                </IconButton>
              }
            >
              <div className="cx-right">
                <div className="cx-tabs" role="tablist" aria-label="Analysis views">
                  {(['experiment', 'job', 'agent', 'feed'] as Tab[]).map((t) => (
                    <button
                      key={t}
                      role="tab"
                      aria-selected={tab === t}
                      className={tab === t ? 'selected' : ''}
                      onClick={() => setTab(t)}
                    >
                      {t === 'experiment'
                        ? 'Experiment'
                        : t === 'job'
                          ? 'Job'
                          : t === 'agent'
                            ? `Agent${detail?.revisions.length ? ` ${detail.revisions.length}` : ''}`
                            : 'Feed'}
                    </button>
                  ))}
                </div>
                <div className="cx-right-scroll">
                  {!signedIn ? (
                    <div className="cx-empty">
                      <h3>Welcome to cortex²</h3>
                      <p>
                        We work backwards from an EEG recording to the brain-model parameters that
                        could have produced it, using AI-designed quantum circuits on IBM hardware,
                        Extropic&apos;s THRML sampler and classical baselines. Sign in in the left
                        pane to begin.
                      </p>
                    </div>
                  ) : tab === 'experiment' ? (
                    <ExperimentTab
                      detail={detail}
                      config={config}
                      client={client}
                      selectedJob={selectedJob}
                      run={run}
                      setRun={setRun}
                      onRun={(r) => void runJob(r)}
                      busy={busy}
                      onSelectJob={(id) => (setSelectedJobId(id), setTab('job'))}
                    />
                  ) : tab === 'job' ? (
                    <JobTab job={selectedJob ?? stageJob} config={config} truth={truth} />
                  ) : tab === 'agent' ? (
                    <AgentTimeline
                      revisions={detail?.revisions ?? []}
                      client={client}
                      onSelectJob={(id) => (setSelectedJobId(id), setTab('job'))}
                      agentConfigured={config?.agent_configured ?? false}
                      model={config?.model ?? 'agent'}
                    />
                  ) : (
                    <FeedTab items={feed} client={client} />
                  )}
                </div>
                {signedIn && (
                  <div className="chat-compose cx-compose">
                    {ibmConfirm}
                    {quick}
                    {composer(true)}
                  </div>
                )}
              </div>
            </WorkspacePane>
          )}
        </div>
      </main>
    </div>
  );
}
