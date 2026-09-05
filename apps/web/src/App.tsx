import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BrainScene } from '@little-brain/brain';
import { createTwin } from '@little-brain/core';
import {
  Brain,
  Plug,
  Users,
  ShieldCheck,
  Battery,
  Download,
  Eye,
  Layers,
  MessageCircle,
  PanelLeft,
  Minus,
  Orbit,
  Pause,
  Play,
  Plus,
  Search,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useWorkspace, useSettings } from './useWorkspace';
import { useBrain } from './useBrain';
import { ChatPanel, Composer, IconButton } from './components';
import { useCamera, CameraPreview, summarizeObservations } from './camera';
import { WorkspacePane } from './WorkspacePane';
import { workContextFor } from './workContext';
import { Startup } from './Startup';
import { useAttention } from './attention/useAttention';
import { FocusedPlugin } from './plugins/FocusedPlugin';
import { usePluginInteractions } from './plugins/usePluginInteractions';
import { browserBridge, type BrowserBridge, type BrowserAction } from './plugins/browserAdapter';
import { browserTool } from './plugins/browserTool';
import { PluginsPanel } from './plugins/PluginsPanel';
import { useBackgroundBrains, BackgroundPanel } from './background';
import LocalDataPanel from './LocalDataPanel';

declare global {
  interface Window {
    brainMobile?: { platform: 'ios' | 'android' };
    brainDesktop?: {
      platform: string;
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      openBrowser?: BrowserBridge['openBrowser'];
      browserAction?: BrowserBridge['browserAction'];
      onPluginInteraction?: BrowserBridge['onPluginInteraction'];
    };
  }
}
type View = 'brain' | 'thoughts' | 'plugins' | 'circle';

export default function App() {
  const { workspace, setWorkspace, updateTwin, storageError, storageReady, twin } = useWorkspace();
  const { settings, setSettings } = useSettings();
  const [focusedPluginId, setFocusedPluginId] = useState<string | null>(null);
  const [view, setView] = useState<View>('brain');
  const [leftOpen, setLeftOpen] = useState(() => !matchMedia('(max-width: 900px)').matches);
  const [leftWidth, setLeftWidth] = useState(242);
  const [chatOpen, setChatOpen] = useState(false);
  const [inside, setInside] = useState(false);
  const [query, setQuery] = useState('');
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 900px)').matches);
  useEffect(()=>{if(focusedPluginId&&compact){setLeftOpen(false);setChatOpen(false);}},[focusedPluginId,compact]);
  const [dialog, setDialog] = useState<'settings' | 'create' | 'edit' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('');
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  const [token, setToken] = useState(settings.token);
  const [connectionError, setConnectionError] = useState('');
  const [health, setHealth] = useState<{ configured: boolean; model: string } | null>(null);
  const [pluginError, setPluginError] = useState('');
  const [saved, setSaved] = useState(false);
  const main = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openChat = () => {
    setChatOpen(true);
    if (compact) setLeftOpen(false);
  };
  const pluginStage = usePluginInteractions();
  const bridge = browserBridge();
  const [browserSessions, setBrowserSessions] = useState<
    Record<string, { twinId: string; allowControl: boolean }>
  >({});
  const browserOwners = useRef(browserSessions);
  browserOwners.current = browserSessions;
  const allowedBrowsers = Object.entries(browserSessions)
    .filter(([, value]) => value.twinId === twin.id && value.allowControl)
    .map(([id]) => id);
  const runtime = useMemo(
    () => ({
      tools: allowedBrowsers.length ? [browserTool] : [],
      run: async (name: string, args: unknown, signal: AbortSignal) => {
        if (name !== 'browser_action' || !bridge)
          throw new Error('This plugin tool is unavailable.');
        const action = args as BrowserAction;
        const owner = browserOwners.current[action?.instanceId];
        if (!owner || owner.twinId !== twin.id || !owner.allowControl || signal.aborted)
          throw new Error('This browser session is not enabled for this brain.');
        pluginStage.update(action.instanceId, { label: `Browser · ${action.action}` });
        return JSON.parse(await bridge.browserAction(action));
      },
    }),
    [allowedBrowsers.join(','), twin.id, bridge, pluginStage.update],
  );
  const brain = useBrain(twin, updateTwin, settings, openChat, runtime);
  const visibleInteractions = pluginStage.interactions
    .filter((value) => value.twinId === twin.id)
    .sort((a, b) => Number(a.id === focusedPluginId) - Number(b.id === focusedPluginId))
    .slice(-6);
  const focusedInteraction = visibleInteractions.find((value) => value.id === focusedPluginId);
  const activeInteraction =
    focusedInteraction?.status === 'active'
      ? focusedInteraction
      : [...visibleInteractions].reverse().find((value) => value.status === 'active');
  useEffect(() => {
    if (focusedPluginId && !focusedInteraction) setFocusedPluginId(null);
  }, [focusedPluginId, focusedInteraction]);
  const fileInteraction = useRef<string | null>(null);
  useEffect(() => {
    if (!brain.thinking && fileInteraction.current) {
      pluginStage.finish(fileInteraction.current, brain.error ? 'error' : 'complete');
      fileInteraction.current = null;
    }
  }, [brain.thinking, brain.error, pluginStage.finish]);
  useEffect(
    () =>
      bridge?.onPluginInteraction((event) => {
        if (!browserOwners.current[event.id]) return;
        if (event.status === 'active')
          pluginStage.update(event.id, {
            label: event.label,
            imageUrl: event.imageUrl,
            viewport: event.viewport,
            media: event.media,
          });
        else {
          pluginStage.finish(event.id, event.status);
          setBrowserSessions((values) => {
            const next = { ...values };
            delete next[event.id];
            browserOwners.current = next;
            return next;
          });
        }
      }),
    [bridge, pluginStage.update, pluginStage.finish],
  );
  const openPluginBrowser = async (url: string, options?: { allowControl?: boolean }) => {
    if (!bridge) throw new Error('This plugin is available in the desktop app.');
    const id = crypto.randomUUID();
    const owner = { twinId: twin.id, allowControl: options?.allowControl === true };
    browserOwners.current = { ...browserOwners.current, [id]: owner };
    setBrowserSessions(browserOwners.current);
    pluginStage.begin(twin.id, 'browser', 'Opening browser', 'browser', id);
    setView('brain');
    try {
      await bridge.openBrowser(url, { ...options, interactionId: id });
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : 'Could not open browser.');
      pluginStage.finish(id, 'error');
      setBrowserSessions((values) => {
        const next = { ...values };
        delete next[id];
        browserOwners.current = next;
        return next;
      });
      throw error;
    }
  };
  useEffect(() => {
    brain.updatePluginContext(
      allowedBrowsers.length
        ? `User-enabled isolated browser instance IDs: ${allowedBrowsers.join(', ')}. Use browser_action to read the page first and operate only for the user's requested task. No other browser is available. You must ask before consequential submissions or sharing sensitive data.`
        : '',
    );
  }, [allowedBrowsers.join(','), brain.updatePluginContext]);
  const shareFile = async (text: string) => {
    const id = pluginStage.begin(twin.id, 'files', 'Reading a shared passage');
    fileInteraction.current = id;
    setView('brain');
    const sent = await brain.send(text);
    if (!sent) {
      pluginStage.finish(id, 'error');
      fileInteraction.current = null;
    }
    return sent;
  };
  const camera = useCamera();
  const background = useBackgroundBrains({ twins: workspace.twins, settings, ready: storageReady });
  useEffect(() => {
    if (camera.status === 'off' || camera.status === 'error') return;
    const id = pluginStage.begin(twin.id, 'camera', 'Looking through the camera');
    return () => pluginStage.finish(id);
  }, [
    camera.status === 'off' || camera.status === 'error',
    twin.id,
    pluginStage.begin,
    pluginStage.finish,
  ]);
  useEffect(() => {
    if (!brain.voice) return;
    const id = pluginStage.begin(twin.id, 'voice', 'Listening and speaking');
    return () => pluginStage.finish(id);
  }, [brain.voice, twin.id, pluginStage.begin, pluginStage.finish]);
  const circleJob = background.jobs.find((job) => job.id === background.activeJobId);
  useEffect(() => {
    if (!circleJob) return;
    const ids = circleJob.participants.map((participant) =>
      pluginStage.begin(participant.id, 'circle', 'Working in brain circle'),
    );
    return () => ids.forEach((id) => pluginStage.finish(id));
  }, [circleJob?.id, pluginStage.begin, pluginStage.finish]);
  const workContext = useMemo(
    () => workContextFor(twin.id, background.jobs),
    [twin.id, background.jobs],
  );
  useEffect(() => {
    brain.updateWorkContext(
      workContext.text,
      workContext.thoughts.map((thought) => thought.id),
    );
  }, [workContext, brain.updateWorkContext]);
  const runningJob = background.jobs.find((job) => job.id === background.activeJobId);
  const workingIds = new Set(runningJob?.participants.map((participant) => participant.id) ?? []);
  const attention = useAttention(
    twin.id,
    brain.thinking || workingIds.has(twin.id) || !!activeInteraction,
    camera.status === 'running' && camera.objects.length > 0,
    brain.paused,
    storageReady,
    [...workingIds],
    workspace.twins.map((current) => current.id),
  );
  const manualFocusUntil = useRef(0);
  const focusSceneThought = (id: string) => {
    manualFocusUntil.current = Date.now() + 7000;
    brain.setActiveThoughtId(id);
  };
  const distracted =
    !!attention.distraction &&
    !brain.thinking &&
    !workingIds.has(twin.id) &&
    Date.now() > manualFocusUntil.current;
  const platform = window.brainDesktop ? 'desktop' : window.brainMobile?.platform || 'web';
  const desktop = window.brainDesktop;
  const contextUpdate = useRef(brain.updateVisualContext);
  contextUpdate.current = brain.updateVisualContext;

  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const changed = () => setCompact(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (dialog) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialog]);
  useEffect(() => {
    const abort = new AbortController();
    fetch(new URL('/api/health', settings.endpoint || location.origin), { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setHealth)
      .catch(() => {
        if (!abort.signal.aborted) setHealth(null);
      });
    return () => abort.abort();
  }, [settings.endpoint, saved, dialog]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setChatOpen(false);
        setDialog(null);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault();
        setChatOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const visible = camera.status === 'running' ? camera.objects : [];
    contextUpdate.current(
      visible.length
        ? summarizeObservations(visible)
        : camera.status === 'running'
          ? 'Camera is on. No objects are confidently detected in the current view.'
          : '',
      visible.map((object) => object.id),
    );
  }, [camera.objects, camera.status, twin.id]);

  const visionThoughts = useMemo(
    () =>
      camera.objects.map((object) => ({
        id: object.id,
        text: `${object.label} · ${Math.round(object.score * 100)}%`,
        x: (object.x + object.width / 2) * 2 - 1,
        y: (object.y + object.height / 2) * 2 - 1,
      })),
    [camera.objects],
  );
  const thoughts = useMemo(() => {
    const recent = twin.messages.slice(-40);
    const focused = twin.messages.find((message) => message.id === brain.activeThoughtId);
    return [
      ...(focused && !recent.includes(focused) ? [focused] : []),
      ...recent,
      ...visionThoughts,
      ...workContext.thoughts,
    ];
  }, [twin.messages, visionThoughts, brain.activeThoughtId, workContext]);
  const status = brain.paused
    ? 'Resting'
    : brain.status === 'connecting'
      ? 'Connecting…'
      : brain.thinking
        ? 'Thinking…'
        : brain.voice
          ? 'Listening'
          : camera.status === 'running'
            ? 'Looking around'
            : workingIds.has(twin.id)
              ? 'Working in circle'
              : distracted
                ? 'A little distracted'
                : 'Here with you';
  const chooseView = (next: View) => {
    setView(next);
    if (next !== 'brain') camera.stop();
  };
  const selectTwin = (id: string) => {
    if (id !== twin.id) {
      camera.stop();
      brain.disconnect();
      setWorkspace((w) => ({ ...w, activeId: id }));
    }
    setView('brain');
  };
  const openEditor = (kind: 'create' | 'edit') => {
    setName(kind === 'create' ? '' : twin.name);
    setPersonality(
      kind === 'create'
        ? 'Curious, kind, and playful. Help me think things through.'
        : twin.personality,
    );
    setDialog(kind);
  };
  const saveTwin = () => {
    if (!name.trim()) return;
    camera.stop();
    brain.disconnect();
    if (dialog === 'create') {
      const next = createTwin(name, personality);
      setWorkspace((w) => ({ ...w, twins: [...w.twins, next], activeId: next.id }));
    } else
      updateTwin(twin.id, (current) => ({
        ...current,
        name: name.trim().slice(0, 40),
        personality: personality.slice(0, 1200),
      }));
    setDialog(null);
    setView('brain');
  };
  const exportTwin = () => {
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), twin }, null, 2)],
        { type: 'application/json' },
      ),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${twin.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-thoughts.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const focusThought = (id: string) => {
    focusSceneThought(id);
    setView('brain');
    setSettings((s) => ({ ...s, showThoughts: true }));
  };
  const toggleCamera = () => {
    if (camera.status !== 'off' && camera.status !== 'error') camera.stop();
    else {
      setView('brain');
      void camera.start();
    }
  };
  const composerProps = {
    onSend: brain.send,
    onVoice: () => {
      setView('brain');
      void brain.toggleVoice();
    },
    onStop: brain.stop,
    thinking: brain.thinking,
    voice: brain.voice,
    disabled: brain.paused || !storageReady,
    name: twin.name,
    onCamera: toggleCamera,
    cameraActive: camera.status !== 'off' && camera.status !== 'error',
  };

  return (
    <div
      className={`app simple-app ${chatOpen ? 'chat-open' : ''} ${desktop ? 'desktop' : ''}`}
      style={{ '--chat-width': `${settings.chatWidth}px` } as CSSProperties}
    >
      {desktop && (
        <div className={`window-bar ${desktop.platform === 'darwin' ? 'mac' : ''}`}>
          <span className="window-title">My Little Brain</span>
          {desktop.platform !== 'darwin' && (
            <div className="window-controls">
              <IconButton label="Minimize window" onClick={desktop.minimize}>
                <Minus size={13} />
              </IconButton>
              <IconButton label="Maximize window" onClick={desktop.toggleMaximize}>
                <Square size={11} />
              </IconButton>
              <IconButton label="Close window" className="window-close" onClick={desktop.close}>
                <X size={14} />
              </IconButton>
            </div>
          )}
        </div>
      )}
      <main className="workspace" ref={main} inert={!storageReady}>
        <header className="simple-header">
          <div className="workspace-brand">
            <IconButton
              label={leftOpen ? 'Hide brains pane' : 'Open brains pane'}
              active={leftOpen}
              onClick={() => {
                setLeftOpen((open) => !open);
                if (compact) setChatOpen(false);
              }}
            >
              <PanelLeft size={19} />
            </IconButton>
            <span className="cute-logo">
              <Brain size={21} />
            </span>
            <span>my little brain</span>
          </div>
          <div className="focused-brain">
            <span className="twin-dot" style={{ background: twin.color }} />
            <strong>{twin.name}</strong>
            <span className="brain-status" aria-live="polite">
              {status}
            </span>
          </div>
          <div className="simple-header-actions">
            <IconButton
              label={brain.paused ? 'Wake brain' : 'Pause brain'}
              onClick={() => {
                if (!brain.paused) {
                  camera.stop();
                  if (workingIds.has(twin.id)) background.stop();
                }
                brain.togglePause();
              }}
            >
              {brain.paused ? <Play size={17} /> : <Pause size={17} />}
            </IconButton>
            <button
              className={`chat-toggle ${chatOpen ? 'active' : ''}`}
              aria-label={chatOpen ? 'Close conversation' : 'Open conversation'}
              onClick={() => {
                if (chatOpen) setChatOpen(false);
                else openChat();
              }}
            >
              <MessageCircle size={18} />
              <span>Chat</span>
            </button>
          </div>
        </header>
        <div className="workspace-body">
          {leftOpen && (
            <WorkspacePane
              side="left"
              title="Your brains"
              width={leftWidth}
              onResize={setLeftWidth}
              onClose={() => setLeftOpen(false)}
              actions={
                <IconButton
                  label="Create a brain"
                  onClick={() => openEditor('create')}
                  disabled={workspace.twins.length >= 50}
                >
                  <Plus size={17} />
                </IconButton>
              }
            >
              <div className="pane-brain-list">
                {workspace.twins.map((current) => (
                  <button
                    className={`pane-brain ${current.id === twin.id ? 'selected' : ''}`}
                    key={current.id}
                    onClick={() => {
                      selectTwin(current.id);
                      if (compact) setLeftOpen(false);
                    }}
                  >
                    <span
                      className="pane-brain-avatar"
                      style={{ background: current.color + '30' }}
                    >
                      <Brain size={25} />
                    </span>
                    <span>
                      <strong>{current.name}</strong>
                      <small>
                        {current.id === twin.id
                          ? status
                          : workingIds.has(current.id)
                            ? 'Working in circle'
                            : 'Ready when you are'}
                      </small>
                    </span>
                    {current.id === twin.id && <span className="selected-dot" />}
                  </button>
                ))}
              </div>
              <div className="pane-view-tabs">
                <button
                  className={view === 'brain' ? 'selected' : ''}
                  onClick={() => {
                    chooseView('brain');
                    if (compact) setLeftOpen(false);
                  }}
                >
                  <Brain size={17} />
                  Brain
                </button>
                <button
                  className={view === 'thoughts' ? 'selected' : ''}
                  onClick={() => {
                    chooseView('thoughts');
                    if (compact) setLeftOpen(false);
                  }}
                >
                  <Orbit size={17} />
                  Thoughts<span>{twin.messages.length || ''}</span>
                </button>
              </div>
              <div className="pane-view-tabs secondary-tabs">
                <button
                  className={view === 'circle' ? 'selected' : ''}
                  onClick={() => {
                    chooseView('circle');
                    if (compact) setLeftOpen(false);
                  }}
                >
                  <Users size={17} />
                  Brain circle{background.activeJobId && <span className="selected-dot" />}
                </button>
                <button
                  className={view === 'plugins' ? 'selected' : ''}
                  onClick={() => {
                    chooseView('plugins');
                    if (compact) setLeftOpen(false);
                  }}
                >
                  <Plug size={17} />
                  Connections
                </button>
              </div>
              <div className="pane-bottom">
                <span
                  className="local-save-badge"
                  title="Local journal; selected context is sent to OpenAI for replies"
                >
                  <ShieldCheck size={12} />
                  Saved on this device
                </span>
                <button onClick={() => openEditor('edit')}>About {twin.name}</button>
                <button onClick={() => setDialog('settings')}>
                  <SettingsIcon size={17} />
                  Settings
                </button>
              </div>
            </WorkspacePane>
          )}
          <section className="main-content">
            {view === 'brain' ? (
              <div className="simple-habitat">
                <BrainScene
                  thoughts={thoughts}
                  pluginInteractions={visibleInteractions}
                  activePluginInteractionId={activeInteraction?.id ?? null}
                  focusedPluginInteractionId={focusedPluginId}
                  onPluginMove={(id, x, y) => pluginStage.update(id, { x, y })}
                  onPluginFocus={setFocusedPluginId}
                  activeThoughtId={distracted ? null : brain.activeThoughtId}
                  energy={attention.energy}
                  distraction={distracted ? attention.distraction : null}
                  thinking={brain.thinking}
                  paused={brain.paused}
                  showThoughts={
                    !focusedInteraction && (settings.showThoughts || camera.status === 'running')
                  }
                  reducedMotion={settings.reducedMotion}
                  color={twin.color}
                  anatomyMode={inside}
                  onThoughtSelect={focusSceneThought}
                  onThoughtMove={(id, x, y) =>
                    updateTwin(twin.id, (current) => ({
                      ...current,
                      messages: current.messages.map((message) =>
                        message.id === id ? { ...message, x, y } : message,
                      ),
                    }))
                  }
                />
                <div
                  className="energy-pill"
                  title="Playful focus energy: work and visual observations replenish it; idle time drains it."
                >
                  <Battery size={14} />
                  <meter aria-label="Focus energy" min={0} max={1} value={attention.energy} />
                  <span>{Math.round(attention.energy * 100)}%</span>
                  <small>
                    {distracted
                      ? 'Mind wandering'
                      : workingIds.has(twin.id) || brain.thinking
                        ? 'Finding a spark'
                        : 'Focus'}
                  </small>
                </div>
                <span className="orbit-hint">Drag to look around · settles back to face you</span>
                <div className="scene-options">
                  <button
                    className={inside ? 'selected' : ''}
                    aria-pressed={inside}
                    onClick={() => setInside((value) => !value)}
                  >
                    <Layers size={15} />
                    <span>Inside</span>
                  </button>
                  <button
                    className={settings.showThoughts ? 'selected' : ''}
                    aria-pressed={settings.showThoughts}
                    onClick={() => setSettings((s) => ({ ...s, showThoughts: !s.showThoughts }))}
                  >
                    <Eye size={15} />
                    <span>Thoughts</span>
                  </button>
                </div>
                {camera.status !== 'off' && (
                  <div className="camera-position">
                    <CameraPreview camera={camera} />
                  </div>
                )}
                {brain.paused && (
                  <div className="resting-note">
                    Taking a moment.<button onClick={brain.togglePause}>Wake {twin.name}</button>
                  </div>
                )}
              </div>
            ) : view === 'plugins' ? (
              <PluginsPanel
                platform={platform}
                cameraActive={camera.status !== 'off' && camera.status !== 'error'}
                voiceActive={brain.voice}
                onCamera={toggleCamera}
                onVoice={() => {
                  setView('brain');
                  void brain.toggleVoice();
                }}
                onCircle={() => chooseView('circle')}
                onShare={shareFile}
                openBrowser={bridge ? openPluginBrowser : undefined}
              />
            ) : view === 'circle' ? (
              <BackgroundPanel
                background={{
                  ...background,
                  start: (options) => {
                    background.start(options);
                    setView('brain');
                  },
                }}
                twins={workspace.twins}
              />
            ) : (
              <div className="simple-thoughts">
                <div className="thoughts-heading">
                  <div>
                    <h1>Thoughts</h1>
                    <p>{twin.name}’s conversations, kept here.</p>
                  </div>
                  <IconButton label="Export thoughts" onClick={exportTwin}>
                    <Download size={18} />
                  </IconButton>
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Search thoughts"
                    placeholder="Find a thought"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="thought-list">
                  {twin.messages
                    .filter((message) => message.text.toLowerCase().includes(query.toLowerCase()))
                    .map((message) => (
                      <button
                        key={message.id}
                        className="thought-list-item"
                        onClick={() => focusThought(message.id)}
                      >
                        <span>{message.role === 'user' ? 'You' : twin.name}</span>
                        <p>{message.text || 'Listening…'}</p>
                        <time>
                          {new Date(message.createdAt).toLocaleDateString([], {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </time>
                      </button>
                    ))}
                </div>
                {!twin.messages.length && (
                  <div className="thoughts-empty">
                    <Orbit size={28} />
                    <p>
                      Start a conversation.
                      <br />
                      Your thoughts will find a home here.
                    </p>
                    <button
                      onClick={() => {
                        setView('brain');
                        setChatOpen(true);
                      }}
                    >
                      Talk to {twin.name}
                    </button>
                  </div>
                )}
              </div>
            )}
            {focusedInteraction && (
              <FocusedPlugin
                interaction={focusedInteraction}
                bridge={bridge}
                onClose={() => setFocusedPluginId(null)}
                onStop={
                  focusedInteraction.pluginId === 'browser'
                    ? undefined
                    : () => {
                        if (focusedInteraction.pluginId === 'camera') camera.stop();
                        else if (focusedInteraction.pluginId === 'voice') brain.disconnect();
                        else if (focusedInteraction.pluginId === 'circle') background.stop();
                        else brain.stop();
                        pluginStage.finish(focusedInteraction.id);
                        setFocusedPluginId(null);
                      }
                }
              />
            )}
            {!(compact && chatOpen) && !focusedInteraction && (
              <div className="floating-compose">
                <Composer {...composerProps} />
                {pluginError && (
                  <div className="inline-error" role="alert">
                    {pluginError}
                    <button onClick={() => setPluginError('')}>Dismiss</button>
                  </div>
                )}
                {brain.error && !chatOpen && (
                  <div className="inline-error" role="alert">
                    {brain.error}
                    <button onClick={() => setChatOpen(true)}>Open chat</button>
                  </div>
                )}
              </div>
            )}
          </section>
          {chatOpen && (
            <WorkspacePane
              side="right"
              title="Conversation"
              width={settings.chatWidth}
              onResize={(chatWidth) => setSettings((current) => ({ ...current, chatWidth }))}
              onClose={() => setChatOpen(false)}
              actions={
                <IconButton label="Export conversation" onClick={exportTwin}>
                  <Download size={16} />
                </IconButton>
              }
            >
              <ChatPanel
                twin={twin}
                onClose={() => setChatOpen(false)}
                onFocus={focusThought}
                activeId={brain.activeThoughtId}
                thinking={brain.thinking}
                status={brain.status}
                error={brain.error}
                onDismissError={() => brain.setError('')}
                composer={compact ? <Composer {...composerProps} compact /> : null}
                onExport={exportTwin}
              />
            </WorkspacePane>
          )}
        </div>
      </main>
      <Startup reducedMotion={settings.reducedMotion} />
      {!storageReady && (
        <div className="startup still restore-overlay" role="status">
          Opening your local journal…
        </div>
      )}
      {storageError && (
        <div className="storage-warning" role="alert">
          {storageError}
        </div>
      )}
      <dialog
        className="brain-dialog simple-dialog"
        ref={dialogRef}
        onCancel={() => setDialog(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setDialog(null);
        }}
      >
        <div className="dialog-heading">
          <h2>
            {dialog === 'settings'
              ? 'Settings'
              : dialog === 'create'
                ? 'A new brain'
                : dialog === 'delete'
                  ? `Delete ${twin.name}?`
                  : `About ${twin.name}`}
          </h2>
          <IconButton label="Close dialog" onClick={() => setDialog(null)}>
            <X size={19} />
          </IconButton>
        </div>
        {dialog === 'settings' ? (
          <div className="settings-content">
            <section>
              <h3>{twin.name}</h3>
              <button className="plain-setting" onClick={() => openEditor('edit')}>
                <span>Name & personality</span>
                <span>Edit</span>
              </button>
              <div className="plain-setting">
                <span>Less motion</span>
                <button
                  className={`toggle ${settings.reducedMotion ? 'on' : ''}`}
                  role="switch"
                  aria-label="Less motion"
                  aria-checked={settings.reducedMotion}
                  onClick={() => setSettings((s) => ({ ...s, reducedMotion: !s.reducedMotion }))}
                >
                  <span />
                </button>
              </div>
              <button className="plain-setting" onClick={exportTwin}>
                <span>Export conversations</span>
                <Download size={16} />
              </button>
            </section>
            <section>
              <h3>
                Connection{' '}
                <span className={health?.configured ? 'connected' : ''}>
                  {health?.configured ? 'Ready' : 'Not connected'}
                </span>
              </h3>
              <p className="settings-description">
                OpenAI Realtime · {health?.model || 'gpt-realtime-2.1'}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    if (endpoint) {
                      const url = new URL(endpoint);
                      if (
                        !['http:', 'https:'].includes(url.protocol) ||
                        url.username ||
                        url.password ||
                        url.pathname !== '/' ||
                        url.search ||
                        url.hash
                      )
                        throw new Error('Use a server origin, such as https://brain.example.com.');
                      if (location.protocol === 'https:' && url.protocol === 'http:')
                        throw new Error('Use HTTPS for this connection.');
                    }
                    brain.disconnect();
                    setSettings((s) => ({ ...s, endpoint: endpoint.replace(/\/$/, ''), token }));
                    setConnectionError('');
                    setSaved(true);
                    setTimeout(() => setSaved(false), 1500);
                  } catch (error) {
                    setConnectionError(error instanceof Error ? error.message : 'Invalid URL.');
                  }
                }}
              >
                <label className="field-label">
                  Server URL
                  <input
                    type="url"
                    placeholder="This app’s server"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                  />
                </label>
                <label className="field-label">
                  Access token
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="For a remote server, if needed"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </label>
                <p className="field-help">
                  Your OpenAI key stays on the server. This access token is kept for this session.
                </p>
                {connectionError && (
                  <p className="form-error" role="alert">
                    {connectionError}
                  </p>
                )}
                <button className="primary-button" type="submit">
                  {saved ? 'Saved' : 'Save connection'}
                </button>
              </form>
            </section>
            <LocalDataPanel
              workspace={workspace}
              setWorkspace={setWorkspace}
              storageError={storageError}
            />
            <section className="settings-note">
              Your journal is stored locally, without cloud sync. OpenAI receives conversation
              context, circle tasks, and anything you explicitly share for a reply. Camera frames
              stay here; detected labels are sent when connected. Local storage is not encrypted by
              this app.
            </section>
          </div>
        ) : dialog === 'delete' ? (
          <>
            <p>
              This removes this brain and its {twin.messages.length} saved thoughts from this
              device.
            </p>
            <div className="dialog-actions">
              <button className="outline-button" onClick={exportTwin}>
                Export first
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  camera.stop();
                  brain.disconnect();
                  setWorkspace((w) => {
                    const twins = w.twins.filter((current) => current.id !== twin.id);
                    return { ...w, twins, activeId: twins[0].id };
                  });
                  setDialog(null);
                }}
              >
                Delete brain
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveTwin();
            }}
          >
            <label className="field-label">
              Name
              <input
                autoFocus
                required
                maxLength={40}
                placeholder="A name for your brain"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field-label">
              Personality
              <textarea
                rows={4}
                maxLength={1200}
                value={personality}
                onChange={(event) => setPersonality(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              {dialog === 'edit' && workspace.twins.length > 1 && (
                <button type="button" className="delete-link" onClick={() => setDialog('delete')}>
                  <Trash2 size={14} />
                  Delete
                </button>
              )}
              <button className="primary-button" disabled={!name.trim()} type="submit">
                {dialog === 'create' ? 'Create brain' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
