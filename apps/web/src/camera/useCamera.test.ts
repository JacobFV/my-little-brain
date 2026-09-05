// @vitest-environment jsdom
import { createElement, StrictMode } from 'react';
import { CameraPreview } from './CameraPreview';
import { act, render, renderHook, cleanup } from '@testing-library/react';
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

describe('camera startup feedback', () => {
  it('times out an unanswered permission request and releases any late stream', async () => {
    vi.useFakeTimers();
    const { hook, getUserMedia, media, stop } = setup();
    let grant!: (value: unknown) => void;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    let settled = false;
    act(() => {
      void hook.result.current.start().then(() => {
        settled = true;
      });
    });
    expect(hook.result.current.status).toBe('loading');
    expect(hook.result.current.progress).toMatch(/permission/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30001);
    });
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(/permission.*timed out/i);
    expect(settled).toBe(true);
    await act(async () => {
      grant(media);
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(hook.result.current.status).toBe('error');
  });
  it('settles a cancelled camera request before the permission prompt is answered', async () => {
    const { hook, getUserMedia } = setup();
    getUserMedia.mockReturnValue(new Promise(() => {}));
    let settled = false;
    act(() => {
      void hook.result.current.start().then(() => {
        settled = true;
      });
    });
    await act(async () => {
      hook.result.current.stop();
    });
    expect(settled).toBe(true);
    expect(hook.result.current.status).toBe('off');
  });
  it('times out a stalled video preview and releases the camera', async () => {
    vi.useFakeTimers();
    const { hook, video, stop } = setup();
    vi.mocked(video.play).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      void hook.result.current.start();
    });
    expect(hook.result.current.progress).toMatch(/preview/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15001);
    });
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(/preview.*timed out/i);
    expect(stop).toHaveBeenCalledOnce();
  });
  it.each([
    ['NotAllowedError', /permission was denied/i],
    ['NotFoundError', /no camera/i],
    ['NotReadableError', /another app|in use/i],
  ])('explains camera %s failures', async (name, message) => {
    const { hook, getUserMedia } = setup();
    getUserMedia.mockRejectedValue(new DOMException('Opaque browser error', name));
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(message);
  });
  it('does not stop capture when the preview mounts in StrictMode', async () => {
    detector.load.mockReturnValue(new Promise(() => {}));
    const { hook, stop } = setup();
    await act(async () => {
      void hook.result.current.start();
    });
    render(
      createElement(
        StrictMode,
        null,
        createElement(CameraPreview, { camera: hook.result.current }),
      ),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe('loading');
  });
  it('explains unavailable camera capture without leaving startup pending', async () => {
    const { hook } = setup();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await act(async () => {
      await hook.result.current.start();
    });
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toMatch(/HTTPS|desktop app/i);
    expect(hook.result.current.progress).toBe('');
  });
});
