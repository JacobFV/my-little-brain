import { useEffect, useMemo, useRef, useState } from 'react';
import { BrainScene } from '@little-brain/brain';
import { Activity, Brain, ChevronRight, CircleHelp, Cpu, FlaskConical, LogIn, LogOut, Play, Plus, Radio, RefreshCw, Send, SlidersHorizontal, Sparkles, X } from 'lucide-react';

type Provider = 'classical' | 'ibm_simulator' | 'ibm_quantum' | 'extropic_simulator';
type Job = {
  id: string; provider: Provider; status: string; title: string;
  created_at?: string; provider_job_id?: string; objective?: number;
  result?: Record<string, unknown>; error?: string;
};
type Signal = { channel: string; alpha: number; beta: number; theta: number; delta: number; quality: string; samples?: number[] };
type AuthUser = { email?: string; name?: string; picture?: string };
type Analysis = { id: string; kind: string; text: string; time: string };
const API = (import.meta.env.VITE_CORTEX_API || '').replace(/\/$/, '');
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const sources = [
  { name: 'frontal left', x: 27, y: 34 }, { name: 'frontal right', x: 72, y: 34 },
  { name: 'temporal left', x: 17, y: 53 }, { name: 'temporal right', x: 83, y: 53 },
  { name: 'parietal left', x: 34, y: 64 }, { name: 'parietal right', x: 66, y: 64 },
  { name: 'occipital left', x: 40, y: 79 }, { name: 'occipital right', x: 60, y: 79 },
];
function sampleWave(now: number, channel: number): number[] {
  return Array.from({ length: 130 }, (_, i) => {
    const t = (i + now * 1.4) / 13;
    return Math.sin(t * (7 + channel * .35)) * .5 +
      Math.sin(t * 16 + channel * 1.2) * .18 +
      Math.sin(t * 2.4 + channel) * .22;
  });
}
function Trace({ values, tint = '#8a8cc5' }: { values: number[]; tint?: string }) {
  const maxAmplitude = Math.max(1e-6, ...values.map(v => Math.abs(v)));
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1,values.length - 1) * 260).toFixed(1)},${(21 - (v / maxAmplitude) * 16).toFixed(1)}`).join(' ');
  return <svg className="cx-trace" viewBox="0 0 260 42" preserveAspectRatio="none" aria-label="EEG waveform">
    <path d="M0 21H260" stroke="#a8adab" strokeOpacity=".25" strokeDasharray="3 4"/>
    <path d={d} stroke={tint} strokeWidth="1.6" fill="none" vectorEffect="non-scaling-stroke"/>
  </svg>;
}
function Histogram({ bins }: { bins: Array<{ state: string; count: number }> }) {
  const max = Math.max(1, ...bins.map(b => b.count));
  return <div className="cx-hist">
    {bins.slice(0, 12).map(b => <div className="cx-hist-row" key={b.state}>
      <code>{b.state}</code><div className="cx-hist-track"><span style={{ width: `${100 * b.count / max}%` }}/></div><span>{b.count}</span>
    </div>)}
  </div>;
}
export default function ResearchLab() {
  const [token, setToken] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const signInHost = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<'activity' | 'quantum'>('activity');
  const [brainView, setBrainView] = useState<'anatomy' | 'inside' | 'avatar'>('inside');
  const [provider, setProvider] = useState<Provider>('classical');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState(0);
  const [live, setLive] = useState(false);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [busy, setBusy] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  const [ingestToken, setIngestToken] = useState('');
  const [info, setInfo] = useState('preview mode: illustrative eeg. hardware and cloud jobs require authentication and a deployed api.');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [opacity, setOpacity] = useState(0.52);
  const clock = useRef(0);
  const selectedJob = jobs.find(j => j.id === selected) || jobs[0] || null;
  const bins = useMemo(() => {
    const counts = selectedJob?.result?.counts;
    return counts && typeof counts === 'object'
      ? Object.entries(counts as Record<string, number>).map(([state, count]) => ({state, count})).sort((a,b)=>b.count-a.count)
      : [];
  }, [selectedJob]);
  useEffect(() => {
    const timer = window.setInterval(() => { clock.current++; setPhase(clock.current); }, 220);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || token) return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      const google = (window as any).google;
      if (!google || !signInHost.current) return;
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (r: { credential: string }) => setToken(r.credential),
      });
      google.accounts.id.renderButton(signInHost.current, { theme: 'outline', size: 'medium', shape: 'pill' });
    };
    document.head.appendChild(script);
    return () => { script.remove(); };
  }, [token]);
  useEffect(() => {
    if (!token) { setUser(null); setJobs([]); setIngestToken(''); setAutopilot(false); return; }
    let alive = true;
    fetch(`${API}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => { if (!r.ok) throw new Error(`sign-in rejected (${r.status})`); return r.json(); })
      .then(data => { if (alive) { setUser(data); setInfo('authenticated. experiments are persisted on the research backend.'); } })
      .catch(e => { if (alive) { setToken(''); setInfo(String(e)); } });
    return () => { alive = false; };
  }, [token]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const reload = async () => {
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [jr, sr, ar] = await Promise.all([
          fetch(`${API}/v1/jobs`, { headers }),
          fetch(`${API}/v1/eeg/latest`, { headers }),
          fetch(`${API}/v1/analyses`, { headers }),
        ]);
        if (!jr.ok) throw new Error(`jobs unavailable (${jr.status})`);
        if (!cancelled) {
          setJobs((await jr.json()).jobs || []);
          if (sr.ok) { const e = await sr.json(); setSignal(e.signal || null); setLive(Boolean(e.live)); }
          if (ar.ok) setAnalyses((await ar.json()).analyses || []);
        }
      } catch (e) { if (!cancelled) setInfo(String(e)); }
    };
    void reload();
    const timer = window.setInterval(() => void reload(), 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [token]);
  const send = async (path: string, data: Record<string, unknown>) => {
    if (!token) { setInfo('sign in with google before submitting cloud work.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.detail || `http ${r.status}`);
      setInfo(payload.message || 'request accepted');
      if (payload.job) { setJobs(j => [payload.job, ...j]); setSelected(payload.job.id); }
      if (payload.token) setIngestToken(payload.token);
      if (payload.analysis) setAnalyses(a => [payload.analysis, ...a]);
    } catch(e) { setInfo(String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/v1/session`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('session settings unavailable')))
      .then(v => setAutopilot(Boolean(v.autopilot)))
      .catch(e => setInfo(String(e)));
  }, [token]);
  const toggleAutopilot = async (enabled: boolean) => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/v1/session`, { method: 'POST',
        headers: {'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body: JSON.stringify({autopilot:enabled}) });
      if (!r.ok) throw new Error(`autopilot update failed (${r.status})`);
      const result = await r.json();
      setAutopilot(Boolean(result.autopilot));
      setInfo(result.autopilot ? 'bounded research autopilot enabled (max 4 automatic software jobs)' : 'autopilot disabled');
    } catch (e) { setInfo(String(e)); }
  };
  const project = sources.map((n, i) => ({
    ...n,
    value: signal ? [signal.alpha,signal.beta,signal.theta,signal.delta][i % 4] / 100 :
      (0.25 + Math.sin(phase * .16 + i * 1.18) * .19 + Math.sin(phase * .08 - i) * .09),
  }));
  return <div className="cx-shell">
    <header className="cx-top">
      <div className="cx-brand"><button onClick={() => setLeftOpen(!leftOpen)} aria-label="toggle left pane">☷</button><Brain size={19}/><b>cortex²</b><span className="cx-subtitle">my little research brain</span></div>
      <div className="cx-head-status"><span className={live ? 'cx-dot live' : 'cx-dot'}/>{live ? 'live eeg stream' : 'synthetic preview'} <span className="cx-divider">·</span> {jobs.filter(j=>['queued','running','submitted'].includes(j.status)).length} active jobs</div>
      <div className="cx-auth">{user ? <><span>{user.name || user.email}</span><button onClick={() => {setToken('');setUser(null);}}>sign out <LogOut size={13}/></button></> : <><div ref={signInHost}/>{!GOOGLE_CLIENT_ID && <span>google oauth not configured</span>}</> }
        <button onClick={() => setRightOpen(!rightOpen)} aria-label="toggle analysis pane"><SlidersHorizontal size={16}/></button>
      </div>
    </header>
    <div className="cx-body">
      {leftOpen && <aside className="cx-side cx-left">
        <div className="cx-side-title">research workspace <button title="add experiment" onClick={() => setInfo('create a job from the quantum pane or ask the agent to investigate a hypothesis.')}><Plus size={16}/></button></div>
        <div className="cx-group-title"><Radio size={14}/> acquisition</div>
        <div className="cx-item selected"><Activity size={16}/><span>eeg session<small>{live ? 'connected • real samples' : 'synthetic demonstration'}</small></span></div>
        <button className="cx-item" disabled={!user || busy} onClick={()=>void send('/v1/eeg/ingest-token',{})}><Radio size={16}/> pair openbci bridge</button>
        {ingestToken && <div className="cx-ingest"><b>45-minute bridge token</b><code>{ingestToken}</code><button onClick={()=>void navigator.clipboard?.writeText(ingestToken)}>copy token</button><small>run the local bridge with CORTEX_INGEST_TOKEN. keep this token private.</small></div>}
        <div className="cx-group-title"><FlaskConical size={14}/> experiments</div>
        <div className="cx-job-list">
          {jobs.length === 0 ? <p className="cx-empty">no experiments yet. sign in, then dispatch a benchmark or solver job.</p> : jobs.map(job => <button key={job.id} className={selectedJob?.id === job.id ? 'cx-item selected' : 'cx-item'} onClick={() => {setSelected(job.id);setActiveTab('quantum');}}>
            <Cpu size={16}/><span>{job.title || job.provider}<small>{job.provider.replace('_',' ')} · {job.status}</small></span><ChevronRight size={13}/>
          </button>)}
        </div>
        <div className="cx-group-title"><Sparkles size={14}/> research agent</div>
        <button className="cx-item" onClick={() => setInfo('all agent events and provider jobs are durable server records, not browser-local timers.')}><Sparkles size={16}/> session memory <CircleHelp size={13}/></button>
        <div className="cx-left-bottom"><a href="/" aria-label="return to my little brain">← original little brain</a><span>hackathon research module</span></div>
      </aside>}
      <main className="cx-center">
        <div className="cx-stage-toolbar"><div className="cx-tabs"><button className={activeTab==='activity'?'current':''} onClick={()=>setActiveTab('activity')}>brain activity</button><button className={activeTab==='quantum'?'current':''} onClick={()=>setActiveTab('quantum')}>quantum workbench</button></div>
          <span>{activeTab==='activity' ? 'orbit to inspect · hover signal nodes' : 'computational backend: '+(selectedJob?.provider||provider)}</span>
        </div>
        {activeTab==='activity' ? <>
          <div className="cx-stage">
            <BrainScene thoughts={[]} activeThoughtId={null} thinking={false} paused={false} showThoughts={false} onThoughtSelect={()=>{}} anatomyMode={brainView !== 'avatar'} color="#e0b4ba" researchOverlay={{ intensities: project.map(p=>p.value), opacity }}/>
            <div className="cx-legend"><b>activity propagation</b><span>{live ? 'eeg-derived features' : 'SIMULATED · not source-localized'}</span></div>
            <div className="cx-stage-controls">
              <button className={brainView==='avatar'?'active':''} onClick={()=>setBrainView('avatar')}>cute</button>
              <button className={brainView==='anatomy'?'active':''} onClick={()=>setBrainView('anatomy')}>cortex</button>
              <button className={brainView==='inside'?'active':''} onClick={()=>setBrainView('inside')}>x-ray</button>
            </div>

          </div>
          <div className="cx-strip"><span>overlay opacity</span><input aria-label="overlay opacity" type="range" min={0} max={1} step={.01} value={opacity} onChange={e=>setOpacity(+e.target.value)}/><span>activity nodes: 8 · illustrative atlas mapping</span></div>
          <div className="cx-signals"><div className="cx-signals-head"><b>eeg signatures</b><span>{live?'hardware stream':'synthetic preview'} · 4 channels</span></div>
            {[0,1,2,3].map((i)=><div className="cx-signal-row" key={i}><span>ch {i+1}</span><Trace values={live && signal?.samples?.length ? signal.samples : sampleWave(phase,i)} tint={['#80ab9b','#b39bbd','#a4a8d0','#b8a084'][i]}/><small>{live ? 'live' : 'demo'}</small></div>)}
          </div>
        </> : <div className="cx-workbench">
          <div className="cx-section-head"><div><h2>quantum hypothesis exploration</h2><p>shared 8-bit binary energy objective · 4 neural parameters · 256 candidate configurations</p></div><Cpu size={22}/></div>
          <label className="cx-label">compute provider</label>
          <select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="classical">classical exact enumeration</option><option value="ibm_simulator">qiskit statevector simulator</option><option value="ibm_quantum">ibm quantum physical qpu</option><option value="extropic_simulator">extropic-compatible thermodynamic simulator</option></select>
          <button className="cx-primary" disabled={!user || busy} onClick={()=>void send('/v1/jobs',{provider, kind:'inverse_search', title:'8-bit neural inverse search'})}><Play size={14}/> dispatch experiment</button>
          <div className="cx-circuit"><div className="cx-circuit-head"><b>qaoa circuit inspector</b><span>{selectedJob?.provider_job_id ? 'provider id: '+selectedJob.provider_job_id : 'awaiting execution'}</span></div>
            {Array.from({length:8},(_,i)=><div className="cx-qubit" key={i}><code>q{i}</code><span className="cx-wire"/>{Array.from({length:7},(_,k)=><span className={k%3===0?'cx-gate accent':'cx-gate'} key={k}>{k%3===0?'h':k%3===1?'rz':'rx'}</span>)}</div>)}
            <p>schematic only; replace with serialized actual transpiled circuit after a successful job.</p>
          </div>
          <div className="cx-hist-card"><b>sampled bitstrings</b>{bins.length?<Histogram bins={bins}/>:<p className="cx-empty">no measured results. launch a provider job to populate this histogram.</p>}</div>
          {selectedJob?.error && <p className="cx-error">{selectedJob.error}</p>}
        </div>}
      </main>
      {rightOpen && <aside className="cx-side cx-right">
        <div className="cx-side-title">analyses <button aria-label="close analysis" onClick={()=>setRightOpen(false)}><X size={16}/></button></div>
        <div className="cx-analysis-scroll"><div className="cx-analysis-card"><div className="cx-card-kicker"><Activity size={13}/> observation</div><h3>eeg feature summary</h3>
          {(['alpha','beta','theta','delta'] as const).map((band,i)=><div className="cx-feature" key={band}><span>{band}</span><div><i style={{width:`${signal ? signal[band] : [58,32,45,18][i]}%`}}/></div><b>{signal ? signal[band].toFixed(1) : [58,32,45,18][i]}%</b></div>)}
          <small>{live?'stream-derived bandpower':'illustrative values — not measured data'}</small></div>
          <div className="cx-analysis-card"><div className="cx-card-kicker"><Cpu size={13}/> active hypothesis</div><h3>inverse neural model</h3><p>search excitatory drive, inhibitory gain, recurrent excitation and synaptic timescale. compare synthetic ground truth to inferred configurations.</p><small>no diagnosis or seizure localization claims</small></div>
          {selectedJob && <div className="cx-analysis-card"><div className="cx-card-kicker"><Cpu size={13}/> {selectedJob.status}</div><h3>{selectedJob.title}</h3><p>provider: {selectedJob.provider}</p><p>objective: {typeof selectedJob.objective==='number' ? selectedJob.objective.toFixed(5) : 'pending'}</p><code>{selectedJob.id}</code></div>}
          {analyses.map(a => <div className="cx-analysis-card" key={a.id}><div className="cx-card-kicker"><Sparkles size={13}/> {a.kind}</div><p>{a.text}</p><small>{a.time}</small></div>)}
        </div>
        <div className="cx-agent"><div className="cx-agent-heading"><Sparkles size={15}/> gpt research operator <span>{user?'authenticated':'sign in required'}</span></div>
          <label className="cx-autopilot"><input type="checkbox" checked={autopilot} disabled={!user} onChange={e=>void toggleAutopilot(e.target.checked)}/> allow bounded autonomous follow-ups <small>software only · max 4</small></label>
          <form onSubmit={e=>{e.preventDefault();if(!prompt.trim())return;void send('/v1/agent/commands',{command:prompt.trim()});setPrompt('');}}><textarea aria-label="agent command" placeholder="ask the agent to design, run, inspect or revise an experiment…" value={prompt} onChange={e=>setPrompt(e.target.value)}/><button disabled={!user || busy || !prompt.trim()} aria-label="send agent command"><Send size={16}/></button></form>
          <p>{info}</p>
        </div>
      </aside>}
    </div>
    <style>{`
      .cx-shell{--ink:#526358;--line:#dce5db;--wash:#f1f5ef;--glass:rgba(255,255,255,.82);display:flex;flex-direction:column;height:100dvh;background:#f2f5ef;color:var(--ink);font:13px/1.5 "DM Sans",sans-serif}
      .cx-shell *{box-sizing:border-box}.cx-shell button,.cx-shell select,.cx-shell textarea{font:inherit}.cx-shell button{cursor:pointer}.cx-shell button:disabled{opacity:.45;cursor:not-allowed}.cx-top{height:61px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:0 18px;gap:12px;background:#f8fbf7}
      .cx-brand,.cx-auth,.cx-head-status,.cx-side-title,.cx-group-title,.cx-item,.cx-stage-toolbar,.cx-tabs,.cx-stage-controls,.cx-feature,.cx-agent-heading,.cx-circuit-head,.cx-signals-head,.cx-signal-row,.cx-qubit{display:flex;align-items:center;gap:9px}
      .cx-brand b{font-size:17px;color:#405c4a}.cx-brand button,.cx-auth button,.cx-side-title button{display:flex;align-items:center;justify-content:center;padding:7px;border-radius:9px;color:#748377}.cx-subtitle{color:#96a398;margin-left:10px;font-size:12px}
      .cx-head-status{font-size:12px;color:#849184}.cx-divider{color:#cad5c9}.cx-dot{width:8px;height:8px;border-radius:50%;background:#d3b77e}.cx-dot.live{background:#4ba984}.cx-auth{font-size:11px;white-space:nowrap}.cx-auth button{gap:5px}
      .cx-body{flex:1;min-height:0;display:flex}.cx-side{display:flex;flex-direction:column;min-width:0;background:var(--glass);backdrop-filter:blur(22px)}.cx-left{width:242px;flex-shrink:0;border-right:1px solid var(--line)}.cx-right{width:354px;flex-shrink:0;border-left:1px solid var(--line)}
      .cx-side-title{justify-content:space-between;font-weight:700;font-size:12px;padding:17px 17px 15px;border-bottom:1px solid var(--line)}.cx-group-title{padding:25px 18px 9px;color:#8f9a91;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
      .cx-item{border-radius:12px;text-align:left;min-height:42px;width:calc(100% - 20px);margin:3px 10px;padding:9px 11px;color:#647668}.cx-item.selected{background:#e8f0e6;color:#446b52}.cx-item span{flex:1}.cx-item small{display:block;font-size:10px;opacity:.72}.cx-job-list{overflow-y:auto;max-height:38vh}.cx-empty{font-size:12px;color:#9aaa9b;padding:10px 14px;line-height:1.7}.cx-ingest{margin:8px 16px;padding:9px;border-radius:10px;background:#e9f2ea;font-size:10px;overflow-wrap:anywhere}.cx-ingest code{display:block;padding:7px 0;word-break:break-all}.cx-ingest small{display:block;color:#849586}.cx-autopilot{font-size:11px;display:flex;align-items:center;gap:7px;margin-bottom:10px}.cx-autopilot small{color:#99a69b;margin-left:auto}.cx-left-bottom{margin-top:auto;padding:16px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);font-size:11px}.cx-left-bottom span{color:#a0aa9d}
      .cx-center{flex:1;min-width:0;display:flex;flex-direction:column}.cx-stage-toolbar{height:49px;border-bottom:1px solid var(--line);justify-content:space-between;padding:0 19px;font-size:11px;color:#92a092}.cx-tabs{height:100%;gap:18px}.cx-tabs button{height:100%;border-bottom:2px solid transparent;color:#879789}.cx-tabs button.current{color:#53695a;border-color:#819c84;font-weight:700}
      .cx-stage{flex:1;position:relative;min-height:220px;overflow:hidden;background:radial-gradient(ellipse at 50% 42%,#fcfffa,#eaf2e9)}.cx-stage-controls{position:absolute;top:15px;right:17px;padding:4px;background:#fffc;border:1px solid #dce7dd;border-radius:12px;z-index:8}.cx-stage-controls button{padding:5px 11px;border-radius:8px;font-size:11px}.cx-stage-controls button.active{background:#e5eee3;color:#477357}
      .cx-legend{position:absolute;bottom:16px;left:17px;z-index:8;display:flex;flex-direction:column;gap:2px;font-size:11px}.cx-legend span{font-size:10px;color:#8b9b8e}.cx-marker-layer{position:absolute;inset:0;pointer-events:none;z-index:7}.cx-marker{position:absolute;pointer-events:auto;border:1px solid #729e9b;background:#68a9b366;width:11px;height:11px;border-radius:50%;box-shadow:0 0 0 5px #5ea9b213}.cx-tooltip{position:absolute;bottom:20px;left:15px;width:155px;padding:10px;text-align:left;background:#fff;border:1px solid var(--line);border-radius:11px;box-shadow:0 12px 35px #49614a22;font-size:11px;z-index:9}.cx-tooltip strong{display:block;font-size:17px}.cx-tooltip small{display:block;color:#9daa9e}
      .cx-strip{height:37px;border-top:1px solid var(--line);display:flex;align-items:center;gap:15px;padding:0 19px;font-size:11px;color:#849486}.cx-strip input{width:105px}.cx-strip span:last-child{margin-left:auto}
      .cx-signals{background:#fafcf9;border-top:1px solid var(--line);padding:13px 18px 15px}.cx-signals-head{justify-content:space-between;font-size:12px;margin-bottom:7px}.cx-signals-head span{font-size:10px;color:#9da99d}.cx-signal-row{height:31px;gap:12px;color:#93a092;font-size:11px}.cx-signal-row>span{width:25px}.cx-trace{width:100%;height:30px}.cx-signal-row>small{width:31px}
      .cx-analysis-scroll{flex:1;min-height:0;overflow:auto;padding:13px}.cx-analysis-card{background:#fffaf9a6;border:1px solid #e0e7df;border-radius:15px;margin-bottom:11px;padding:15px;box-shadow:0 7px 30px #556c5908}.cx-card-kicker{display:flex;gap:6px;align-items:center;color:#849b8e;text-transform:uppercase;font-size:10px;letter-spacing:.04em}.cx-analysis-card h3{font-size:14px;color:#4f6554;margin:8px 0}.cx-analysis-card p{font-size:12px;color:#728174}.cx-analysis-card small{font-size:10px;color:#a0a9a0}.cx-analysis-card code{font-size:10px;overflow-wrap:anywhere}
      .cx-feature{justify-content:space-between;margin:9px 0;font-size:11px}.cx-feature span{width:35px}.cx-feature>div{height:6px;background:#e8ece9;border-radius:9px;flex:1;overflow:hidden}.cx-feature i{display:block;height:100%;background:#a8b6cf;border-radius:9px}.cx-feature b{width:38px;font-size:10px;text-align:right}
      .cx-agent{border-top:1px solid var(--line);padding:13px}.cx-agent-heading{font-weight:700;font-size:12px;margin-bottom:10px}.cx-agent-heading span{font-weight:400;font-size:10px;color:#a1aaa1;margin-left:auto}.cx-agent form{position:relative}.cx-agent textarea{width:100%;min-height:80px;max-height:170px;resize:vertical;border:1px solid #d7e3d7;border-radius:13px;background:#fff;padding:11px 38px 11px 11px;font-size:12px;color:#506654}.cx-agent form button{position:absolute;bottom:10px;right:9px;background:#dfeee0;border-radius:8px;padding:6px}.cx-agent>p{color:#92a094;font-size:10px;max-height:70px;overflow:auto}
      .cx-workbench{flex:1;overflow:auto;padding:24px;max-width:900px;width:100%;margin:auto}.cx-section-head{display:flex;align-items:center;justify-content:space-between}.cx-section-head h2{font-size:20px;margin:0;color:#4e6554}.cx-section-head p{font-size:12px;color:#93a093}.cx-label{display:block;font-size:11px;font-weight:700;margin:22px 0 7px}.cx-workbench select{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;width:100%;color:#52665a}.cx-primary{background:#698a74!important;color:#fff!important;padding:10px 16px;border-radius:10px;display:flex;gap:8px;align-items:center;margin-top:14px}.cx-circuit,.cx-hist-card{border:1px solid var(--line);background:#fff9;border-radius:14px;padding:17px;margin-top:20px}.cx-circuit-head{justify-content:space-between;margin-bottom:14px}.cx-circuit-head span{font-size:10px;color:#a6aba6}.cx-qubit{height:28px;gap:6px;font-size:11px}.cx-qubit code{width:30px}.cx-wire{height:1px;flex:1;background:#a6acb0}.cx-gate{border:1px solid #a3b6ac;border-radius:5px;min-width:31px;text-align:center;background:#edf5ed;padding:2px}.cx-gate.accent{background:#eee7f8;border-color:#c9b5df}.cx-circuit>p{color:#9aa59b;font-size:10px}.cx-hist-row{display:flex;align-items:center;gap:8px;font-size:11px;margin:5px 0}.cx-hist-row code{width:72px}.cx-hist-track{flex:1;background:#e6eee6;height:7px;border-radius:5px}.cx-hist-track span{height:100%;background:#91acb7;display:block;border-radius:5px}.cx-hist-row>span{width:34px;text-align:right}.cx-error{color:#aa5050}
      @media(max-width:950px){.cx-left{width:183px}.cx-right{width:300px}.cx-subtitle,.cx-head-status{display:none}}@media(max-width:700px){.cx-left{display:none}.cx-right{width:100%;position:absolute;right:0;top:61px;bottom:0;z-index:20;background:#fafcf8}.cx-strip span:last-child{display:none}}
    `}</style>
  </div>;
}
