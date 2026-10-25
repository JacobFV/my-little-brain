// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createTwin } from '@little-brain/core';
import { createJob } from './jobs';
import { useBackgroundBrains } from './useBackgroundBrains';
const run = vi.hoisted(() => vi.fn());
vi.mock('./runner', () => ({ runJob: run }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  run.mockReset();
});
describe('background persistence lifecycle', () => {
  it('waits for native restore and never starts restored jobs automatically', () => {
    const twin = createTwin('A'),
      job = createJob('Garden', [twin]);
    job.status = 'running';
    const hook = renderHook(
      ({ ready }) =>
        useBackgroundBrains({ twins: [twin], settings: { endpoint: '', token: '' }, ready }),
      { initialProps: { ready: false } },
    );
    localStorage.setItem('little-brain.background.v1', JSON.stringify([job]));
    expect(hook.result.current.jobs).toEqual([]);
    hook.rerender({ ready: true });
    expect(hook.result.current.jobs[0].status).toBe('interrupted');
    expect(run).not.toHaveBeenCalled();
  });
  it('preserves corrupted persisted notes and blocks new API work', () => {
    localStorage.setItem('little-brain.background.v1', '{broken');
    const twin = createTwin('A');
    const hook = renderHook(() =>
      useBackgroundBrains({ twins: [twin], settings: { endpoint: '', token: '' } }),
    );
    act(() => hook.result.current.start({ topic: 'Garden', twinIds: [twin.id] }));
    hook.unmount();
    expect(localStorage.getItem('little-brain.background.v1')).toBe('{broken');
    expect(run).not.toHaveBeenCalled();
  });
  it('cancels active work when endpoint changes or a participant disappears', async () => {
    const signals: AbortSignal[] = [];
    run.mockImplementation((job, _settings, signal) => {
      signals.push(signal);
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ ...job, status: 'interrupted' }), {
          once: true,
        }),
      );
    });
    const twin = createTwin('A');
    const hook = renderHook(
      ({ endpoint, twins }) => useBackgroundBrains({ twins, settings: { endpoint, token: '' } }),
      { initialProps: { endpoint: '', twins: [twin] } },
    );
    act(() => hook.result.current.start({ topic: 'Garden', twinIds: [twin.id] }));
    await act(async () => hook.rerender({ endpoint: 'https://example.com', twins: [twin] }));
    expect(signals[0].aborted).toBe(true);
    act(() => hook.result.current.start({ topic: 'Garden', twinIds: [twin.id] }));
    await act(async () => hook.rerender({ endpoint: 'https://example.com', twins: [] }));
    expect(signals[1].aborted).toBe(true);
  });
});

it('refuses to start API work if the initial journal cannot be persisted', () => {
  const twin = createTwin('A');
  const hook = renderHook(() =>
    useBackgroundBrains({ twins: [twin], settings: { endpoint: '', token: '' } }),
  );
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => hook.result.current.start({ topic: 'Garden', twinIds: [twin.id] }));
  expect(run).not.toHaveBeenCalled();
  expect(hook.result.current.storageError).toContain('cannot be saved');
  expect(hook.result.current.jobs).toHaveLength(1);
});
it('stops a running job if saving later fails and preserves the in-memory journal', async () => {
  vi.useFakeTimers();
  let active!: AbortSignal;
  run.mockImplementation((job, _settings, signal, onUpdate) => {
    active = signal;
    onUpdate({
      ...job,
      status: 'running',
      transcript: [
        {
          id: 'turn',
          twinId: job.participants[0].id,
          name: 'A',
          text: 'A useful thought',
          createdAt: 1,
        },
      ],
    });
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve(job), { once: true }),
    );
  });
  const twin = createTwin('A');
  const hook = renderHook(() =>
    useBackgroundBrains({ twins: [twin], settings: { endpoint: '', token: '' } }),
  );
  act(() => hook.result.current.start({ topic: 'Garden', twinIds: [twin.id] }));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Full');
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(active.aborted).toBe(true);
  expect(hook.result.current.jobs[0].transcript[0].text).toBe('A useful thought');
  expect(hook.result.current.storageError).toContain('stopped');
  hook.unmount();
  vi.useRealTimers();
});
it('does not resume a job whose participant was deleted', () => {
  const twin = createTwin('A'),
    job = createJob('Garden', [twin]);
  localStorage.setItem('little-brain.background.v1', JSON.stringify([job]));
  const hook = renderHook(() =>
    useBackgroundBrains({ twins: [], settings: { endpoint: '', token: '' } }),
  );
  act(() => hook.result.current.resume(job.id));
  expect(run).not.toHaveBeenCalled();
  expect(hook.result.current.error).toContain('deleted');
});
it('notifies native persistence and refreshes imported journals without running them', () => {
  const twin = createTwin('A'),
    job = createJob('Garden', [twin]);
  const hook = renderHook(() =>
    useBackgroundBrains({ twins: [twin], settings: { endpoint: '', token: '' } }),
  );
  localStorage.setItem('little-brain.background.v1', JSON.stringify([job]));
  act(() => window.dispatchEvent(new Event('little-brain.local-data-restored')));
  expect(hook.result.current.jobs[0].id).toBe(job.id);
  expect(run).not.toHaveBeenCalled();
  const changed = vi.fn();
  window.addEventListener('little-brain.local-data-changed', changed);
  hook.unmount();
  expect(changed).toHaveBeenCalled();
  window.removeEventListener('little-brain.local-data-changed', changed);
});
