// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { nativeStorageRequest } from './nativeStorage';
afterEach(() => {
  delete window.ReactNativeWebView;
  vi.useRealTimers();
});
it('matches asynchronous native responses to their own request', async () => {
  let sent: { requestId: string } | undefined;
  window.ReactNativeWebView = {
    postMessage: (message) => {
      sent = JSON.parse(message);
    },
  };
  const result = nativeStorageRequest('read');
  window.dispatchEvent(
    new CustomEvent('little-brain.native-response', {
      detail: { requestId: 'wrong', raw: 'other' },
    }),
  );
  window.dispatchEvent(
    new CustomEvent('little-brain.native-response', {
      detail: { requestId: sent!.requestId, raw: 'backup' },
    }),
  );
  expect((await result).raw).toBe('backup');
});
it('reports failure instead of claiming native storage succeeded', async () => {
  window.ReactNativeWebView = {
    postMessage: (message) => {
      const { requestId } = JSON.parse(message);
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent('little-brain.native-response', {
            detail: { requestId, error: 'Storage full' },
          }),
        ),
      );
    },
  };
  await expect(nativeStorageRequest('write', '{}')).rejects.toThrow('Storage full');
});
