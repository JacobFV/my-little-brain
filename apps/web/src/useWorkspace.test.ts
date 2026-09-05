// @vitest-environment jsdom
import { renderHook, waitFor, act } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { useWorkspace, useSettings } from './useWorkspace';
vi.mock('./nativeStorage', () => ({
  nativeStorageRequest: vi.fn().mockRejectedValue(new Error('Native disk unavailable')),
}));
afterEach(() => {
  delete window.ReactNativeWebView;
  localStorage.clear();
  sessionStorage.clear();
});
it('unblocks browser settings on native restore failure without native overwrite', async () => {
  window.ReactNativeWebView = { postMessage: vi.fn() };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  const hook = renderHook(() => ({ workspace: useWorkspace(), settings: useSettings() }));
  await waitFor(() => expect(hook.result.current.workspace.storageReady).toBe(true));
  expect(hook.result.current.workspace.storageError).toContain('unavailable');
  act(() => hook.result.current.settings.setSettings((s) => ({ ...s, showThoughts: true })));
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem('little-brain.settings')!).showThoughts).toBe(true),
  );
  const { nativeStorageRequest } = await import('./nativeStorage');
  expect(vi.mocked(nativeStorageRequest).mock.calls.every(([action]) => action === 'read')).toBe(
    true,
  );
  hook.unmount();
});
