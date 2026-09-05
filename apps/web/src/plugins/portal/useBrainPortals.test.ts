// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTwin } from '@little-brain/core';
import { useBrainPortals } from './useBrainPortals';

afterEach(() => cleanup());
it('closes portals on pagehide while allowing a fresh connection after back-forward restoration', () => {
  const twins = [createTwin('A'), createTwin('B')];
  const hook = renderHook(() =>
    useBrainPortals({
      twins,
      settings: { endpoint: '', token: '' },
      updateTwin: vi.fn(),
      foregroundTwinId: twins[1].id,
    }),
  );
  act(() => {
    hook.result.current.open(twins[0].id, twins[1].id);
  });
  expect(hook.result.current.sessions[0].status).toBe('open');
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(hook.result.current.sessions[0].status).toBe('closed');
  act(() => {
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(hook.result.current.sessions).toHaveLength(1);
  act(() => {
    hook.result.current.open(twins[0].id, twins[1].id);
  });
  expect(hook.result.current.sessions[1].status).toBe('open');
  expect(hook.result.current.error).toBe('');
});
it('cancels queued portal messages on unmount', async () => {
  const twins = [createTwin('A'), createTwin('B')];
  const hook = renderHook(() =>
    useBrainPortals({
      twins,
      settings: { endpoint: '', token: '' },
      updateTwin: vi.fn(),
      foregroundTwinId: twins[1].id,
    }),
  );
  let id!: string;
  act(() => {
    id = hook.result.current.open(twins[0].id, twins[1].id)!;
  });
  const reply = hook.result.current.send(id, twins[0].id, 'Hello');
  const rejected = expect(reply).rejects.toThrow('Portal closed');
  hook.unmount();
  await rejected;
});
