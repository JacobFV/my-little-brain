// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAttention } from './useAttention';
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('replenishes working twins even when another brain is selected', () => {
  const hook = renderHook(
    ({ id }) => useAttention(id, false, false, false, true, ['worker'], ['viewer', 'worker']),
    { initialProps: { id: 'viewer' } },
  );
  act(() => vi.advanceTimersByTime(10000));
  expect(hook.result.current.energy).toBeCloseTo(0.79);
  hook.rerender({ id: 'worker' });
  expect(hook.result.current.energy).toBe(1);
});
it('waits for native restore before reading or writing attention', () => {
  const hook = renderHook(({ ready }) => useAttention('brain', false, false, false, ready), {
    initialProps: { ready: false },
  });
  act(() => vi.advanceTimersByTime(10000));
  expect(localStorage.getItem('little-brain.attention.v1')).toBe(null);
  localStorage.setItem('little-brain.attention.v1', JSON.stringify({ brain: 0.2 }));
  hook.rerender({ ready: true });
  expect(hook.result.current.energy).toBe(0.2);
});
it('refreshes restored energy rather than overwriting it with stale state', () => {
  const hook = renderHook(() => useAttention('brain', false, false, false));
  localStorage.setItem('little-brain.attention.v1', JSON.stringify({ brain: 0.3 }));
  act(() => window.dispatchEvent(new Event('little-brain.local-data-restored')));
  expect(hook.result.current.energy).toBe(0.3);
});
