import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUp,
  Mic,
  MicOff,
  Camera,
  CameraOff,
  Square,
  X,
  Brain,
  MessageCircle,
  PanelRightClose,
  Download,
  Check,
  Copy,
  Eye,
} from 'lucide-react';
import type { Twin } from '@little-brain/core';
export function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Composer({
  onSend,
  onVoice,
  onStop,
  thinking,
  voice,
  disabled = false,
  compact = false,
  name,
  onCamera,
  cameraActive = false,
  draft: controlledDraft,
  onDraftChange,
}: {
  onSend: (text: string) => Promise<boolean>;
  onVoice: () => void;
  onStop: () => void;
  thinking: boolean;
  voice: boolean;
  disabled?: boolean;
  compact?: boolean;
  name: string;
  onCamera?: () => void;
  cameraActive?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
}) {
  const [localDraft, setLocalDraft] = useState('');
  const draft = controlledDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const input = useRef<HTMLTextAreaElement>(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || thinking || disabled) return;
    const text = draft;
    setDraft('');
    void onSend(text);
  };
  return (
    <form className={`composer ${compact ? 'compact' : ''}`} onSubmit={submit}>
      {!compact && (
        <div className="composer-spark">
          <MessageCircle size={19} />
        </div>
      )}
      <textarea
        ref={input}
        aria-label={compact ? 'Chat message' : 'Message your brain'}
        placeholder={disabled ? `${name} is resting…` : `What’s on your mind?`}
        value={draft}
        maxLength={12000}
        rows={1}
        autoFocus={compact}
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
        {onCamera && (
          <IconButton
            label={cameraActive ? 'Turn camera off' : 'Turn camera on'}
            active={cameraActive}
            onClick={onCamera}
            disabled={disabled}
          >
            {cameraActive ? <CameraOff size={18} /> : <Camera size={18} />}
          </IconButton>
        )}
        <IconButton
          label={voice ? 'End voice conversation' : 'Start voice conversation'}
          active={voice}
          onClick={onVoice}
          disabled={disabled || (thinking && !voice)}
        >
          {voice ? <MicOff size={18} /> : <Mic size={18} />}
        </IconButton>
        {thinking ? (
          <button className="send-button" type="button" aria-label="Stop response" onClick={onStop}>
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            disabled={!draft.trim() || disabled}
          >
            <ArrowUp size={19} />
          </button>
        )}
      </div>
    </form>
  );
}
export function ChatPanel({
  twin,
  onClose,
  onFocus,
  activeId,
  thinking,
  status,
  error,
  onDismissError,
  composer,
  onExport,
}: {
  twin: Twin;
  onClose: () => void;
  onFocus: (id: string) => void;
  activeId: string | null;
  thinking: boolean;
  status: string;
  error: string;
  onDismissError: () => void;
  composer: React.ReactNode;
  onExport: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [twin.messages, thinking]);
  useEffect(() => {
    follow.current = true;
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [twin.id]);
  return (
    <aside className="chat-panel" aria-label="Conversation">
      <div className="panel-header">
        <div>
          <MessageCircle size={17} />
          <h2>Conversation</h2>
          <span className="count-badge">{twin.messages.length}</span>
        </div>
        <IconButton label="Close conversation" onClick={onClose}>
          <PanelRightClose size={17} />
        </IconButton>
      </div>
      <div className="chat-identity">
        <span className="mini-brain">
          <Brain size={23} />
        </span>
        <div>
          <strong>{twin.name}</strong>
          <span>
            <i className={`status-dot ${status === 'connected' ? 'live' : ''}`} />
            {status === 'connecting'
              ? 'Waking up…'
              : status === 'connected'
                ? 'Here with you'
                : 'Ready when you are'}
          </span>
        </div>
        <IconButton label="Export conversation" onClick={onExport}>
          <Download size={16} />
        </IconButton>
      </div>
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {twin.messages.length === 0 ? (
          <div className="chat-empty">
            <p>Talk it through with {twin.name}.</p>
          </div>
        ) : (
          <>
            {twin.messages.map((message) => (
              <article
                key={message.id}
                className={`message ${message.role} ${activeId === message.id ? 'focused' : ''}`}
              >
                <div className="message-meta">
                  <span>{message.role === 'user' ? 'You' : twin.name}</span>
                  <time title={new Date(message.createdAt).toLocaleString()}>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <div className="message-text">
                  {message.text || (message.role === 'user' ? 'Listening…' : '')}
                  {message.status === 'streaming' && <span className="typing-caret" />}
                </div>
                <div className="message-footer">
                  <button
                    onClick={() => onFocus(message.id)}
                    title="Focus thought"
                    aria-label={activeId === message.id ? 'Thought in focus' : 'Focus thought'}
                  >
                    <Eye size={13} />
                  </button>
                  <span>
                    {message.status === 'failed'
                      ? 'Not sent'
                      : message.status === 'interrupted'
                        ? 'Interrupted'
                        : ''}
                  </span>
                  <button
                    aria-label="Copy message"
                    title="Copy message"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(message.text)
                        .then(() => {
                          setCopied(message.id);
                          setTimeout(() => setCopied(''), 1600);
                        })
                        .catch(() => {});
                    }}
                  >
                    {copied === message.id ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              </article>
            ))}
          </>
        )}
        {thinking && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <small>{twin.name} is thinking</small>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && (
        <div className="chat-error" role="alert">
          <span>{error}</span>
          <IconButton label="Dismiss error" onClick={onDismissError}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {composer && <div className="chat-compose">{composer}</div>}
    </aside>
  );
}
