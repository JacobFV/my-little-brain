import { useCallback, useEffect, useRef, useState } from 'react';
import { createInteraction, mergeInteraction, type PluginInteraction } from './interactions';
export function usePluginInteractions() {
  const [interactions, setInteractions] = useState<PluginInteraction[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const begin = useCallback(
    (
      twinId: string,
      pluginId: string,
      label: string,
      kind: PluginInteraction['kind'] = 'icon',
      id?: string,
    ) => {
      const value = createInteraction(twinId, pluginId, label, kind, id);
      setInteractions((values) => mergeInteraction(values, value));
      return value.id;
    },
    [],
  );
  const update = useCallback(
    (
      id: string,
      patch: Partial<
        Pick<PluginInteraction, 'label' | 'imageUrl' | 'x' | 'y' | 'viewport' | 'media'>
      >,
    ) =>
      setInteractions((values) =>
        values.map((value) =>
          value.id === id && value.status === 'active' ? { ...value, ...patch } : value,
        ),
      ),
    [],
  );
  const finish = useCallback((id: string, status: 'complete' | 'error' = 'complete') => {
    setInteractions((values) =>
      values.map((value) => (value.id === id ? { ...value, status, imageUrl: undefined } : value)),
    );
    if (timers.current.has(id)) clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => {
        setInteractions((values) => values.filter((value) => value.id !== id));
        timers.current.delete(id);
      }, 1800),
    );
  }, []);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );
  return { interactions, begin, update, finish };
}
