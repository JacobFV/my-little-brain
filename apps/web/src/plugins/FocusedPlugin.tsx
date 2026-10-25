import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, Keyboard, Volume2, Mic, Camera, Send } from 'lucide-react';
import type { PluginInteraction } from './interactions';
import type { BrowserBridge, BrowserAction } from './browserAdapter';
import { IntegrationIcon } from './IntegrationIcon';
import { screenPoint } from './focusedCoordinates';
export function FocusedPlugin({
  interaction,
  bridge,
  onClose,
  onStop,
}: {
  interaction: PluginInteraction;
  bridge: BrowserBridge | null;
  onClose: () => void;
  onStop?: () => void;
}) {
  const [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [keyboard, setKeyboard] = useState(false),
    [text, setText] = useState('');
  const touch = useRef<{ x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const actions = useRef(Promise.resolve());
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setReady(false);
    setError('');
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('keydown', key, true);
    if (interaction.kind === 'browser' && bridge)
      void bridge
        .setBrowserFocused(interaction.id, true)
        .then(() => {
          if (generation.current === version) {
            setReady(true);
            surface.current?.focus();
          }
        })
        .catch((e) => setError(String(e.message || e)));
    return () => {
      generation.current++;
      window.removeEventListener('keydown', key, true);
      if (interaction.kind === 'browser' && bridge)
        void bridge.setBrowserFocused(interaction.id, false).catch(() => {});
    };
  }, [interaction.id, interaction.kind, bridge]);
  const manual = (action: Omit<BrowserAction, 'instanceId'>) => {
    if (!bridge || !ready) return;
    const version = generation.current;
    actions.current = actions.current.then(async () => {
      if (generation.current !== version) return;
      try {
        await bridge.manualBrowserAction({ instanceId: interaction.id, ...action });
      } catch (e) {
        if (generation.current === version)
          setError(e instanceof Error ? e.message : 'Browser input failed.');
      }
    });
  };
  const media = interaction.media ?? { audio: false, microphone: false, camera: false };
  const toggleMedia = async (key: 'audio' | 'microphone' | 'camera') => {
    try {
      await bridge?.setBrowserMedia(interaction.id, { [key]: !media[key] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change media permissions.');
    }
  };
  return (
    <section
      className="focused-plugin"
      role="dialog"
      aria-label={`${interaction.label} focused view`}
    >
      <header>
        <span className="focused-plugin-title">
          <IntegrationIcon id={interaction.pluginId} size={19} />
          <strong>{interaction.label}</strong>
          <small>{interaction.status === 'active' ? 'Live session' : interaction.status}</small>
        </span>
        <button aria-label="Close focused view" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {interaction.kind === 'browser' ? (
        <>
          <div
            ref={surface}
            className="focused-browser-screen"
            tabIndex={0}
            aria-label="Browser display. Click to interact; use Keyboard for touch typing."
            onPointerDown={(event) => {
              if (event.pointerType === 'touch') {
                touch.current = { x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => {
              touch.current = null;
            }}
            onPointerUp={(event) => {
              const start = touch.current;
              touch.current = null;
              if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
                manual({ action: 'scroll', deltaY: (start.y - event.clientY) * 2 });
                return;
              }
              if (!interaction.viewport) return;
              const point = screenPoint(
                event.clientX,
                event.clientY,
                event.currentTarget.getBoundingClientRect(),
                interaction.viewport,
              );
              if (point) {
                manual({ action: 'click', ...point });
                surface.current?.focus();
              }
            }}
            onWheel={(event) => {
              event.preventDefault();
              manual({ action: 'scroll', deltaY: Math.max(-1000, Math.min(1000, event.deltaY)) });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Tab') return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
                manual({ action: 'type', text: event.key });
              else
                manual({
                  action: 'key',
                  key: event.key,
                  modifiers: [
                    ...(event.shiftKey ? ['shift' as const] : []),
                    ...(event.ctrlKey ? ['control' as const] : []),
                    ...(event.altKey ? ['alt' as const] : []),
                    ...(event.metaKey ? ['meta' as const] : []),
                  ],
                });
            }}
          >
            {interaction.imageUrl ? (
              <img
                src={interaction.imageUrl}
                alt="Live display of your isolated browser session"
                draggable={false}
              />
            ) : (
              <p>Waiting for the browser display…</p>
            )}
          </div>
          <nav className="focused-plugin-tools" aria-label="Browser controls">
            <button aria-pressed={keyboard} onClick={() => setKeyboard(!keyboard)}>
              <Keyboard size={17} />
              Keyboard
            </button>
            <button
              aria-pressed={media.audio}
              disabled={!ready}
              onClick={() => void toggleMedia('audio')}
            >
              <Volume2 size={17} />
              Audio {media.audio ? 'on' : 'off'}
            </button>
            <button
              aria-pressed={media.microphone}
              disabled={!ready}
              onClick={() => void toggleMedia('microphone')}
            >
              <Mic size={17} />
              Mic {media.microphone ? 'allowed' : 'off'}
            </button>
            <button
              aria-pressed={media.camera}
              disabled={!ready}
              onClick={() => void toggleMedia('camera')}
            >
              <Camera size={17} />
              Camera {media.camera ? 'allowed' : 'off'}
            </button>
            <button
              onClick={() =>
                void bridge
                  ?.showBrowser(interaction.id)
                  .catch((e) => setError(String(e.message || e)))
              }
            >
              <ExternalLink size={17} />
              Session window & devices
            </button>
          </nav>
          {keyboard && (
            <form
              className="browser-typing"
              onSubmit={(event) => {
                event.preventDefault();
                manual({ action: 'type', text });
                setText('');
              }}
            >
              <input
                autoFocus
                aria-label="Text to type into browser"
                value={text}
                maxLength={4000}
                onChange={(event) => setText(event.target.value)}
                placeholder="Tap a field in the page, then type here"
              />
              <button disabled={!text || !ready} aria-label="Type text into browser">
                <Send size={17} />
              </button>
              <button type="button" onClick={() => manual({ action: 'key', key: 'Enter' })}>
                Enter
              </button>
              <button type="button" onClick={() => manual({ action: 'key', key: 'Backspace' })}>
                ⌫
              </button>
            </form>
          )}
          <p className="focused-plugin-help">
            Mic and camera apply only to this site and still require its capture request. Use the
            session window for device selection or native dialogs. Leaving this view turns media
            off.
          </p>
        </>
      ) : (
        <div className="focused-plugin-detail">
          <IntegrationIcon id={interaction.pluginId} size={72} />
          <h2>{interaction.label}</h2>
          <p>This object represents one {interaction.pluginId} interaction with your brain.</p>
          {onStop && interaction.status === 'active' && (
            <button className="outline-button" onClick={onStop}>
              Stop this interaction
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
