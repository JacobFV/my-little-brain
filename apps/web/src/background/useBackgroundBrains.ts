import { useCallback, useEffect, useRef, useState } from 'react';
import type { Twin } from '@little-brain/core';
import { createJob, restoreJobs, type BackgroundJob } from './jobs';
import { runJob } from './runner';
const STORAGE = 'little-brain.background.v1';
type Options = { twins: Twin[]; settings: { endpoint: string; token: string }; ready?: boolean };
export function useBackgroundBrains({ twins, settings, ready = true }: Options) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const current = useRef(jobs);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restored = useRef(false);
  const storageBlocked = useRef(false);
  const save = useCallback(() => {
    if (!restored.current || storageBlocked.current) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(current.current));
      window.dispatchEvent(new Event('little-brain.local-data-changed'));
      if (mounted.current) setStorageError('');
    } catch {
      controller.current?.abort();
      if (mounted.current)
        setStorageError(
          'Background work stopped because notes could not be saved. Export the transcript before closing.',
        );
    }
  }, []);
  const update = useCallback(
    (next: BackgroundJob[]) => {
      current.current = next;
      if (mounted.current) setJobs(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, 250);
    },
    [save],
  );
  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);
  const execute = useCallback(
    (job: BackgroundJob) => {
      if (!restored.current || storageBlocked.current) {
        setError('Background storage is not ready. Existing notes have been preserved.');
        return;
      }
      if (controller.current) {
        setError('Stop the current background job first.');
        return;
      }
      if (job.participants.some((p) => !twins.some((t) => t.id === p.id))) {
        setError('A participating brain was deleted. Create a new job with your current brains.');
        return;
      }
      try {
        localStorage.setItem(STORAGE, JSON.stringify(current.current));
        window.dispatchEvent(new Event('little-brain.local-data-changed'));
      } catch {
        setStorageError('Background work could not start because notes cannot be saved locally.');
        return;
      }
      setError('');
      const abort = new AbortController();
      controller.current = abort;
      setActiveJobId(job.id);
      void runJob(
        job,
        { endpoint: settings.endpoint, token: settings.token },
        abort.signal,
        (value) => update(current.current.map((j) => (j.id === value.id ? value : j))),
      ).finally(() => {
        if (controller.current === abort) {
          controller.current = null;
          if (mounted.current) setActiveJobId(null);
        }
        save();
      });
    },
    [settings.endpoint, settings.token, update, save, twins],
  );
  const start = useCallback(
    ({ topic, twinIds }: { topic: string; twinIds: string[] }) => {
      if (!restored.current || storageBlocked.current) {
        setError('Background storage is not ready. Existing notes have been preserved.');
        return;
      }
      if (controller.current) {
        setError('Stop the current background job first.');
        return;
      }
      try {
        const chosen = twinIds.map((id) => twins.find((t) => t.id === id));
        if (chosen.some((t) => !t)) throw new Error('A selected brain is no longer available.');
        const job = createJob(topic, chosen as Twin[]);
        update([job, ...current.current]);
        execute(job);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not create a job.');
      }
    },
    [twins, update, execute],
  );
  const resume = useCallback(
    (id: string) => {
      const job = current.current.find((j) => j.id === id);
      if (job && job.status !== 'complete') execute(job);
    },
    [execute],
  );
  const remove = useCallback(
    (id: string) => {
      if (controller.current && id === activeJobId) return;
      update(current.current.filter((j) => j.id !== id));
    },
    [activeJobId, update],
  );
  useEffect(() => {
    if (!ready || restored.current) return;
    try {
      const raw = localStorage.getItem(STORAGE);
      const value = restoreJobs(raw);
      if (raw && value.length === 0 && raw.trim() !== '[]') {
        storageBlocked.current = true;
        setStorageError(
          'Saved background notes could not be read. The original data has been preserved; background work is disabled.',
        );
      } else {
        current.current = value;
        setJobs(value);
      }
      restored.current = true;
    } catch {
      storageBlocked.current = true;
      setStorageError('Background storage is unavailable. Work is disabled so notes are not lost.');
    }
  }, [ready]);
  useEffect(() => {
    const refresh = () => {
      if (controller.current) {
        save();
        return;
      }
      try {
        const raw = localStorage.getItem(STORAGE);
        const values = restoreJobs(raw);
        if (raw && values.length === 0 && raw.trim() !== '[]') {
          storageBlocked.current = true;
          setStorageError(
            'Imported background notes could not be read. Existing data has been preserved.',
          );
          return;
        }
        storageBlocked.current = false;
        current.current = values;
        setJobs(values);
        setStorageError('');
      } catch {
        setStorageError('Background storage is unavailable.');
      }
    };
    window.addEventListener('little-brain.local-data-restored', refresh);
    return () => window.removeEventListener('little-brain.local-data-restored', refresh);
  }, [save]);
  useEffect(() => () => stop(), [settings.endpoint, settings.token, stop]);
  useEffect(() => {
    const active = current.current.find((j) => j.id === activeJobId);
    if (active && active.participants.some((p) => !twins.some((t) => t.id === p.id))) stop();
  }, [twins, activeJobId, stop]);
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      stop();
      save();
    };
    window.addEventListener('pagehide', leave);
    return () => {
      mounted.current = false;
      stop();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      save();
      window.removeEventListener('pagehide', leave);
    };
  }, [stop, save]);
  return { jobs, activeJobId, error, storageError, start, resume, stop, remove };
}
export type BackgroundHandle = ReturnType<typeof useBackgroundBrains>;
