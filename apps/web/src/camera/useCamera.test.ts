// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCamera } from './useCamera';
const detector = vi.hoisted(() => ({ load: vi.fn(), detect: vi.fn() }));
vi.mock('./detector', () => ({ loadDetector: detector.load, detectFrame: detector.detect }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const stop = vi.fn();
  const track = { stop, onended: null };
  const media = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(media);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  const hook = renderHook(() => useCamera());
  const video = document.createElement('video');
  Object.defineProperty(video, 'play', { value: vi.fn().mockResolvedValue(undefined) });
  hook.result.current.videoRef.current = video;
  return { hook, stop, getUserMedia, media, video };
}
describe('camera lifecycle', () => {
  it('discards inference completing after stop', async () => {
    detector.load.mockResolvedValue({});
    let resolve!: (value: unknown) => void;
    detector.detect.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { hook, video } = setup();
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 640 },
      videoHeight: { value: 480 },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: () => {},
    })) as unknown as HTMLCanvasElement['getContext']);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe('running');
    act(() => hook.result.current.stop());
    await act(async () => {
      resolve([{ class: 'person', score: 0.9, bbox: [0, 0, 100, 200] }]);
      await Promise.resolve();
    });
    expect(hook.result.current.objects).toEqual([]);
    expect(hook.result.current.status).toBe('off');
  });
  it('never requests the camera until explicit start and releases tracks when stopped during model load', async () => {
    detector.load.mockReturnValue(new Promise(() => {}));
    const { hook, stop, getUserMedia } = setup();
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => {
      void hook.result.current.start();
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe('loading');
    act(() => hook.result.current.stop());
    expect(stop).toHaveBeenCalledOnce();
    expect(hook.result.current.status).toBe('off');
  });
  it('releases a late permission stream after cancellation', async () => {
    const { hook, getUserMedia, media, stop } = setup();
    let resolve!: (value: unknown) => void;
    getUserMedia.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    let start!: Promise<void>;
    act(() => {
      start = hook.result.current.start();
    });
    act(() => hook.result.current.stop());
    await act(async () => {
      resolve(media);
      await start;
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(hook.result.current.status).toBe('off');
  });
  it('releases camera and reports stalled detector loading', async () => {
    vi.useFakeTimers();
    detector.load.mockReturnValue(new Promise(() => {}));
    const { hook, stop } = setup();
    await act(async () => {
      void hook.result.current.start();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(45001));
    expect(stop).toHaveBeenCalledOnce();
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toContain('took too long to load');
  });
  it('releases camera when its owner unmounts', async () => {
    detector.load.mockReturnValue(new Promise(() => {}));
    const { hook, stop } = setup();
    await act(async () => {
      void hook.result.current.start();
      await Promise.resolve();
    });
    hook.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
});
