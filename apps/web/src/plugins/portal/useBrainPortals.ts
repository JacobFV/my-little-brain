import { useCallback, useEffect, useRef, useState } from 'react';
import { PortalRuntime, type PortalOptions, type PortalSession } from './runtime';

export function useBrainPortals(options: PortalOptions) {
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [error, setError] = useState('');
  const runtime = useRef<PortalRuntime | null>(null);
  if (!runtime.current) runtime.current = new PortalRuntime(options, setSessions);
  useEffect(() => {
    runtime.current!.sync(options);
  }, [
    options.twins,
    options.settings.endpoint,
    options.settings.token,
    options.foregroundTwinId,
    options.ready,
    options.environment,
    options.environments,
    options.getEnvironmentImage,
    options.updateTwin,
  ]);
  useEffect(() => {
    // Strict Mode recreates effects; recreate the runtime after its cleanup as well.
    const active = (runtime.current = new PortalRuntime(options, setSessions));
    const close = () => {
      for (const session of active.sessions)
        if (session.status === 'open') active.close(session.id);
    };
    window.addEventListener('pagehide', close);
    return () => {
      active.dispose();
      window.removeEventListener('pagehide', close);
    };
  }, []);
  const open = useCallback((sourceTwinId: string, targetTwinId: string, topic?: string) => {
    try {
      setError('');
      return runtime.current!.open(sourceTwinId, targetTwinId, topic);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open the portal.');
      return undefined;
    }
  }, []);
  const close = useCallback((id: string) => runtime.current!.close(id), []);
  const send = useCallback(
    (id: string, fromTwinId: string, text: string) => runtime.current!.send(id, fromTwinId, text),
    [],
  );
  return {
    sessions,
    thinkingTwinIds: sessions.flatMap((session) =>
      session.status === 'open' && session.draft ? [session.draft.twinId] : [],
    ),
    error: error || sessions.at(-1)?.error || '',
    open,
    close,
    send,
  };
}
export type PortalHandle = ReturnType<typeof useBrainPortals>;
export type { PortalSession, PortalMessage } from './runtime';
