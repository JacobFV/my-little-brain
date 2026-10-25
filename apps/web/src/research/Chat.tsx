import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Atom, Brain, FlaskConical, ImageIcon, Wrench } from 'lucide-react';
import type { ResearchMood } from '@little-brain/brain';
import {
  ApiError,
  type ChatContext,
  type ChatEvent,
  type ChatFocus,
  type ChatMessage,
  type ChatMood,
  type CortexClient,
} from './api';

export const BOOTING_TEXT =
  'My chat circuits are still booting — give me a minute and try again. (The research jobs, EEG and analysis panes still work.)';

export const STARTERS = [
  'Look at my EEG and tell me what you see',
  'Run a quantum search on my last recording',
  'What do you know about me?',
  'Triage the CHB-MIT seizure recording',
];

export function toResearchMood(m: ChatMood | undefined): ResearchMood {
  return !m || m === 'neutral' ? 'idle' : m;
}

export interface ThreadMessage extends ChatMessage {
  key: string;
  failed?: boolean;
}

let seq = 0;
const key = () => `m${Date.now()}-${seq++}`;

/** Chat thread with your brain: history load, send, new conversation. */
export function useChat(
  client: CortexClient,
  enabled: boolean,
  handlers: {
    onFocus: (f: ChatFocus) => void;
    onMood: (m: ResearchMood | null) => void;
    onUnauthorized: () => void;
  },
) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    if (!enabled) {
      setMessages([]);
      setThreadId(null);
      return;
    }
    let live = true;
    client
      .chatHistory()
      .then((r) => {
        if (!live) return;
        setThreadId(r.thread_id);
        setMessages((r.messages ?? []).map((m) => ({ ...m, key: key() })));
      })
      .catch(() => {
        /* backend may not be deployed yet; start empty */
      });
    return () => {
      live = false;
    };
  }, [client, enabled]);

  const send = useCallback(
    async (text: string, context?: ChatContext) => {
      const now = new Date().toISOString();
      setMessages((m) => [...m, { key: key(), role: 'user', text, created_at: now }]);
      setThinking(true);
      h.current.onMood('curious');
      try {
        const r = await client.chat(text, threadId, context);
        setThreadId(r.thread_id);
        setMessages((m) => [
          ...m,
          {
            key: key(),
            role: 'brain',
            text: r.reply,
            events: r.events ?? [],
            mood: r.mood,
            created_at: new Date().toISOString(),
          },
        ]);
        h.current.onMood(toResearchMood(r.mood));
        if (r.focus && (r.focus.experiment_id || r.focus.job_id)) h.current.onFocus(r.focus);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) h.current.onUnauthorized();
        const booting =
          e instanceof ApiError && (e.status === 404 || e.status === 503 || e.status === 0);
        setMessages((m) => [
          ...m,
          {
            key: key(),
            role: 'brain',
            text: booting
              ? BOOTING_TEXT
              : `Hmm, something misfired: ${e instanceof Error ? e.message : String(e)}`,
            mood: 'sleepy',
            failed: true,
            created_at: new Date().toISOString(),
          },
        ]);
        h.current.onMood('sleepy');
      } finally {
        setThinking(false);
      }
    },
    [client, threadId],
  );

  const reset = useCallback(async () => {
    try {
      const r = await client.newChat();
      setThreadId(r.thread_id);
    } catch {
      setThreadId(null);
    }
    setMessages([]);
    h.current.onMood(null);
  }, [client]);

  return { threadId, messages, thinking, send, reset };
}

function EventThumb({ client, path }: { client: CortexClient; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    client
      .artifact(path)
      .then((x) => {
        u = x;
        if (live) setUrl(x);
        else URL.revokeObjectURL(x);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [client, path]);
  if (failed)
    return (
      <span className="cx-chat-thumb missing">
        <ImageIcon size={14} />
      </span>
    );
  return url ? (
    <a className="cx-chat-thumb" href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="" />
    </a>
  ) : (
    <span className="cx-chat-thumb loading" />
  );
}

function EventCard({
  ev,
  client,
  onFocus,
}: {
  ev: ChatEvent;
  client: CortexClient;
  onFocus: (f: ChatFocus) => void;
}) {
  const focusable = !!(ev.experiment_id || ev.job_id);
  const Icon = /quantum|job|qpu|sampl|circuit/i.test(ev.tool)
    ? Atom
    : /experiment|triage|eeg/i.test(ev.tool)
      ? FlaskConical
      : Wrench;
  return (
    <div className={`cx-chat-event ${focusable ? 'focusable' : ''}`}>
      <button
        type="button"
        disabled={!focusable}
        onClick={() =>
          focusable && onFocus({ experiment_id: ev.experiment_id, job_id: ev.job_id })
        }
        title={focusable ? 'Open in the analysis pane' : undefined}
      >
        <Icon size={13} />
        <span>
          <strong>{ev.tool}</strong>
          <small>{ev.summary}</small>
        </span>
      </button>
      {ev.image && <EventThumb client={client} path={ev.image} />}
    </div>
  );
}

export function ChatThread({
  messages,
  thinking,
  client,
  signedIn,
  onFocus,
  onStarter,
}: {
  messages: ThreadMessage[];
  thinking: boolean;
  client: CortexClient;
  signedIn: boolean;
  onFocus: (f: ChatFocus) => void;
  onStarter: (text: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, thinking]);
  if (!messages.length && !thinking)
    return (
      <div className="cx-chat-empty">
        <p>
          {signedIn
            ? "Hi! I'm your little brain. I read your EEG and what you tell me about yourself, and I love running neuroscience experiments on quantum hardware. Where shall we start?"
            : 'Sign in (left pane) so I can see your EEG, your notes and your experiments.'}
        </p>
        {signedIn && (
          <div className="cx-chat-starters">
            {STARTERS.map((s) => (
              <button key={s} type="button" onClick={() => onStarter(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  return (
    <div className="cx-chat-thread" aria-live="polite">
      {messages.map((m) => (
        <div key={m.key} className={`cx-chat-row ${m.role}`}>
          {m.role === 'brain' && (
            <span className="cx-chat-avatar">
              <Brain size={14} />
            </span>
          )}
          <div className="cx-chat-col">
            <div className={`cx-bubble ${m.role} ${m.failed ? 'failed' : ''}`}>{m.text}</div>
            {!!m.events?.length && (
              <div className="cx-chat-events">
                {m.events.map((ev, i) => (
                  <EventCard key={i} ev={ev} client={client} onFocus={onFocus} />
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      {thinking && (
        <div className="cx-chat-row brain">
          <span className="cx-chat-avatar">
            <Brain size={14} />
          </span>
          <div className="cx-bubble brain cx-typing" aria-label="Thinking">
            <i />
            <i />
            <i />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

export function ChatComposer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft('');
    onSend(text);
  };
  return (
    <form className="composer cx-chat-composer" onSubmit={submit}>
      <textarea
        aria-label="Message your brain"
        placeholder={placeholder}
        value={draft}
        maxLength={4000}
        rows={1}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        <button
          className="send-button"
          type="submit"
          aria-label="Send"
          disabled={!draft.trim() || disabled}
        >
          <ArrowUp size={19} />
        </button>
      </div>
    </form>
  );
}
