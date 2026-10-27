import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { BrainScene, type ResearchMood } from '@little-brain/brain';
import {
  Atom,
  Brain,
  ChevronDown,
  FlaskConical,
  Layers,
  LogOut,
  MessageCircle,
  PanelLeft,
  Plus,
  SquarePen,
  Sparkles,
  UserRound,
  Waves,
  Wrench,
} from 'lucide-react';
import { IconButton } from './ui';
import { WorkspacePane } from './WorkspacePane';
import {
  ApiError,
  isActive,
  type Dataset,
  type Experiment,
  type ExperimentDetail,
  type FeedItem,
  type Job,
  type ChatContext,
  type ChatFocus,
  type JobRequest,
  type NewExperiment,
  type Recording,
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
import { averageBands, EEGPanel, TraceStrip } from './EEGPanel';
import { ChatComposer, ChatThread, useChat } from './Chat';
import { ProfileDrawer } from './Profile';
import { useAuth, useBridge, useCompact, usePoll } from './hooks';
import { JobsPanel } from './JobsPanel';
import { anchorsFromEEG, idleAnchors, rms } from './signal';
import './lab.css';

type Tab = 'experiment' | 'job' | 'agent' | 'feed';

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
  const inside = true;
  const fibers = true;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [eegOpen, setEegOpen] = useState(false);
  const [chatMood, setChatMood] = useState<ResearchMood | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedExp, setSelectedExp] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
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
        setToolsOpen(false);
        setAboutOpen(false);
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

  const focus = useCallback(
    (f: ChatFocus) => {
      if (f.experiment_id) setSelectedExp(f.experiment_id);
      if (f.job_id) {
        setSelectedJobId(f.job_id);
        setTab('job');
      } else if (f.experiment_id) setTab('experiment');
      setRightOpen(true);
      if (compact) setLeftOpen(false);
    },
    [compact],
  );
  const chat = useChat(client, signedIn, {
    onFocus: focus,
    onMood: setChatMood,
    onUnauthorized,
  });
  // A reply's mood shows for a while, then the brain returns to its ambient mood.
  useEffect(() => {
    if (!chatMood || chat.thinking) return;
    const t = window.setTimeout(() => setChatMood(null), 9000);
    return () => window.clearTimeout(t);
  }, [chatMood, chat.thinking]);
  const liveContext = (): ChatContext['live'] => {
    if (live.source === 'none' || !live.frame) return undefined;
    const bands = averageBands(live.frame, live.buffer);
    return {
      source: live.source === 'usb' ? 'openbci_usb' : live.source === 'bridge' ? 'openbci_bridge' : 'cloud',
      channels: live.frame.channel_names,
      band_powers: bands
        ? (Object.fromEntries(
            Object.entries(bands).filter(([, v]) => typeof v === 'number'),
          ) as Record<string, number>)
        : undefined,
      blinks: live.blinkCount,
      alpha_ratio: live.frame.alpha_fraction,
    };
  };
  const sendChat = (text: string) =>
    void chat.send(text, {
      experiment_id: selectedExp ?? undefined,
      live: liveContext(),
    });

  const alphaState = live.source === 'bridge' || live.source === 'usb' ? live.frame?.alpha_state : undefined;
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
      mood: chatMood ?? mood,
      blinkSignal: live.blinkCount,
      gaze: null,
    }),
    [anchors, fibers, inside, mood, chatMood, live.blinkCount],
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
    <div
      className="cx-tools-menu"
      role="menu"
      aria-label="Research tools"
      onClick={() => setToolsOpen(false)}
    >
      <small className="cx-tools-head">
        {exp ? `On: ${exp.title}` : 'Select an experiment in the left pane'}
      </small>
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
              My Little Brain <small className="cx-tagline">your brain, studying itself</small>
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
            {signedIn && (
              <>
                <IconButton label="New conversation" onClick={() => void chat.reset()}>
                  <SquarePen size={17} />
                </IconButton>
                <IconButton
                  label="About me"
                  active={aboutOpen}
                  onClick={() => setAboutOpen((o) => !o)}
                >
                  <UserRound size={17} />
                </IconButton>
                <div className="cx-tools-wrap">
                  <IconButton
                    label="Research tools"
                    active={toolsOpen}
                    onClick={() => setToolsOpen((o) => !o)}
                  >
                    <Wrench size={17} />
                  </IconButton>
                  {toolsOpen && quick}
                </div>
              </>
            )}
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
                  ) : null}
                  {signedIn && me?.hardware && (
                    <p className="cx-quota">
                      Real quantum hardware:{' '}
                      <strong>
                        {me.hardware.limit < 0
                          ? 'unlimited'
                          : `${me.hardware.used} / ${me.hardware.limit} jobs today`}
                      </strong>
                      <br />
                      Need more? Email{' '}
                      <a href={`mailto:${me.hardware.contact}?subject=My%20Little%20Brain%20QPU%20quota`}>
                        {me.hardware.contact}
                      </a>{' '}
                      to request a higher limit.
                    </p>
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
                <section className="cx-section cx-eeg-fold">
                  <button
                    className="cx-fold-head"
                    aria-expanded={eegOpen}
                    onClick={() => setEegOpen((o) => !o)}
                  >
                    <span
                      className={`status-dot ${live.source !== 'none' ? 'live' : ''}`}
                    />
                    <strong>EEG</strong>
                    <small>
                      {live.source === 'bridge' || live.source === 'usb'
                        ? 'OpenBCI streaming'
                        : live.source === 'cloud'
                          ? 'cloud stream'
                          : bridgeStatus === 'open'
                            ? 'bridge connected'
                            : 'not streaming'}
                    </small>
                    <ChevronDown size={14} className={eegOpen ? 'open' : ''} />
                  </button>
                </section>
                {eegOpen && (
                <EEGPanel
                  bridge={bridgeStatus}
                  usb={bridge.usb}
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
                )}
                <JobsPanel
                  jobs={jobs}
                  selectedId={selectedJobId}
                  signedIn={signedIn}
                  onSelect={(j) => {
                    setSelectedJobId(j.id);
                    if (j.experiment_id && j.experiment_id !== selectedExp)
                      setSelectedExp(j.experiment_id);
                    setTab(
                      j.kind === 'agent_iteration' ? 'agent' : 'job',
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
                />
              </div>
              <div className="pane-bottom">
                <button className="cx-bottom-link" onClick={() => setAboutOpen(true)} disabled={!signedIn}>
                  <UserRound size={15} /> About me
                </button>
              </div>
            </WorkspacePane>
          )}
          <section className="main-content">
            <div
              className="simple-habitat cx-habitat"
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
              {live.frame && <TraceStrip live={live} />}
            </div>
            <div className="cx-chat-dock">
              <ChatThread
                messages={chat.messages}
                thinking={chat.thinking}
                client={client}
                signedIn={signedIn}
                onFocus={focus}
                onStarter={sendChat}
              />
              <ChatComposer
                disabled={!signedIn || chat.thinking}
                placeholder={
                  signedIn
                    ? chat.thinking
                      ? 'Thinking…'
                      : 'Talk to your brain…'
                    : 'Sign in to talk to your brain'
                }
                onSend={sendChat}
              />
            </div>
            {ibmConfirm}
            {(error || notice) && (
              <div
                className={`connection-feedback cx-toast ${error ? 'error' : ''}`}
                role={error ? 'alert' : 'status'}
              >
                {error || notice}
                <button onClick={() => (setError(''), setNotice(''))}>Dismiss</button>
              </div>
            )}
            {!signedIn && (
              <div className="cx-signin-modal" role="dialog" aria-modal="true" aria-label="Meet your brain">
                <div className="cx-signin">
                      <h2>Meet your brain</h2>
                      <p>Sign in so your brain can remember you.</p>
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
              </div>
            )}
            {aboutOpen && signedIn && (
              <ProfileDrawer
                client={client}
                onClose={() => setAboutOpen(false)}
                onUnauthorized={onUnauthorized}
              />
            )}
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
                      <h3>Welcome to My Little Brain</h3>
                      <p>
                        Your brain tries to understand itself: it reads your EEG and the notes you
                        share, then works backwards to brain-model parameters with AI-designed
                        quantum circuits, THRML sampling and classical baselines. Sign in in the
                        left pane to begin.
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
              </div>
            </WorkspacePane>
          )}
        </div>
      </main>
    </div>
  );
}
