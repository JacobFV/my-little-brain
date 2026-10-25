import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { createTwin, type Workspace, type Twin } from '@little-brain/core';
import { loadSettings, type Settings } from './settings';
import {
  parseLocalBackup,
  exportLocalBackup,
  restoreAuxiliary,
  WorkspaceStorage,
} from './localData';
import { nativeStorageRequest } from './nativeStorage';
export type { Settings } from './settings';
export function useWorkspace() {
  const [initial] = useState(() => {
    const store = new WorkspaceStorage({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    });
    const saved = store.load();
    const twin = createTwin('Pip');
    return { store, workspace: saved || { version: 1 as const, twins: [twin], activeId: twin.id } };
  });
  const [workspace, setWorkspaceState] = useState<Workspace>(initial.workspace);
  const [storageReady, setStorageReady] = useState(!window.ReactNativeWebView);
  const [storageError, setStorageError] = useState(initial.store.error);
  const nativeAvailable = useRef(!window.ReactNativeWebView);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const nativeQueue = useRef(Promise.resolve());
  const setWorkspace = useCallback<Dispatch<SetStateAction<Workspace>>>(
    (update) => {
      if (!storageReady) return;
      setWorkspaceState(update);
    },
    [storageReady],
  );
  useEffect(() => {
    if (!window.ReactNativeWebView) return;
    let disposed = false;
    void nativeStorageRequest('read')
      .then((reply) => {
        if (disposed) return;
        if (reply.raw) {
          const backup = parseLocalBackup(reply.raw);
          if (initial.store.raw === null && !initial.store.blocked) {
            restoreAuxiliary(backup, localStorage);
            if (initial.store.save(backup.workspace)) setWorkspaceState(backup.workspace);
            else setStorageError(initial.store.error);
          } else {
            // Preserve both copies before the browser's current workspace becomes authoritative.
            if (JSON.stringify(backup.workspace) !== initial.store.raw)
              localStorage.setItem(
                `little-brain.workspace.v1.recovery.native.${Date.now()}`,
                reply.raw,
              );
            restoreAuxiliary(backup, localStorage);
          }
        }
        window.dispatchEvent(new Event('little-brain.local-data-restored'));
        nativeAvailable.current = true;
      })
      .catch((error) => {
        if (!disposed)
          setStorageError(
            `Native backup is unavailable: ${error instanceof Error ? error.message : 'restore failed'}`,
          );
      })
      .finally(() => {
        if (!disposed) {
          window.dispatchEvent(new Event('little-brain.local-data-restored'));
          setStorageReady(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [initial]);
  const save = useCallback(() => {
    if (!storageReady) return;
    const saved = initial.store.save(workspaceRef.current);
    if (!saved) {
      setStorageError(initial.store.error);
      return;
    }
    if (window.ReactNativeWebView && nativeAvailable.current) {
      let raw: string;
      try {
        raw = JSON.stringify(exportLocalBackup(workspaceRef.current, localStorage));
      } catch {
        setStorageError('The native backup could not read local data. Export before closing.');
        return;
      }
      nativeQueue.current = nativeQueue.current.then(async () => {
        try {
          await nativeStorageRequest('write', raw);
          setStorageError('');
        } catch (error) {
          setStorageError(
            `Native backup could not be saved: ${error instanceof Error ? error.message : 'write failed'}`,
          );
        }
      });
    } else if (!window.ReactNativeWebView) setStorageError('');
  }, [initial, storageReady]);
  useEffect(() => {
    const timer = setTimeout(save, 250);
    return () => clearTimeout(timer);
  }, [workspace, save]);
  useEffect(() => {
    const recover = (event: Event) => {
      const raw = (event as CustomEvent<string>).detail;
      initial.store.resume(raw);
      setStorageError('');
      save();
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('pagehide', save);
    window.addEventListener('little-brain.local-data-changed', save);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('little-brain.storage-recovered', recover);
    return () => {
      window.removeEventListener('pagehide', save);
      window.removeEventListener('little-brain.local-data-changed', save);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('little-brain.storage-recovered', recover);
    };
  }, [initial, save]);
  const updateTwin = useCallback(
    (id: string, update: (twin: Twin) => Twin) =>
      setWorkspace((w) => ({ ...w, twins: w.twins.map((t) => (t.id === id ? update(t) : t)) })),
    [setWorkspace],
  );
  return {
    workspace,
    setWorkspace,
    updateTwin,
    storageError,
    storageReady,
    twin: workspace.twins.find((t) => t.id === workspace.activeId) ?? workspace.twins[0],
  };
}
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() =>
    loadSettings(
      { getItem: (key) => localStorage.getItem(key) },
      { getItem: (key) => sessionStorage.getItem(key) },
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
      import.meta.env.VITE_API_URL || '',
    ),
  );
  const [ready, setReady] = useState(!window.ReactNativeWebView);
  useEffect(() => {
    const reload = () => {
      setSettings(
        loadSettings(
          localStorage,
          sessionStorage,
          matchMedia('(prefers-reduced-motion: reduce)').matches,
          import.meta.env.VITE_API_URL || '',
        ),
      );
      setReady(true);
    };
    window.addEventListener('little-brain.local-data-restored', reload);
    return () => window.removeEventListener('little-brain.local-data-restored', reload);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      const { token, ...safe } = settings;
      localStorage.setItem('little-brain.settings', JSON.stringify(safe));
      window.dispatchEvent(new Event('little-brain.local-data-changed'));
      sessionStorage.setItem('little-brain.token', token);
    } catch {}
  }, [settings, ready]);
  return { settings, setSettings };
}
