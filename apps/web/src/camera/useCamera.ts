import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { loadDetector, detectFrame } from './detector';
import { trackObjects, type CameraObject } from './tracker';
export type CameraHandle = {
  status: 'off' | 'loading' | 'running' | 'error';
  error: string;
  progress: string;
  objects: CameraObject[];
  videoRef: RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  switchCamera: () => Promise<void>;
};
export function useCamera({
  onObservations,
}: { onObservations?: (objects: CameraObject[]) => void } = {}): CameraHandle {
  const [status, setStatus] = useState<CameraHandle['status']>('off');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [objects, setObjects] = useState<CameraObject[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<ReturnType<typeof setTimeout> | null>(null);
  const facing = useRef<'environment' | 'user'>('environment');
  const observations = useRef<CameraObject[]>([]);
  const callback = useRef(onObservations);
  callback.current = onObservations;
  const cleanup = useCallback(() => {
    generation.current++;
    if (timer.current) clearTimeout(timer.current);
    if (frame.current) clearTimeout(frame.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    observations.current = [];
  }, []);
  const stop = useCallback(() => {
    cleanup();
    setStatus('off');
    setProgress('');
    setObjects([]);
    callback.current?.([]);
  }, [cleanup]);
  const start = useCallback(async () => {
    cleanup();
    const version = generation.current;
    setError('');
    setObjects([]);
    setStatus('loading');
    setProgress('Requesting camera permission…');
    const active = () => version === generation.current;
    const fail = (failure: unknown) => {
      if (!active()) return;
      cleanup();
      setObjects([]);
      callback.current?.([]);
      setStatus('error');
      setProgress('');
      setError(failure instanceof Error ? failure.message : 'Camera could not start.');
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Camera access needs HTTPS or the desktop app.');
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing.current },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      if (!active()) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      for (const track of media.getVideoTracks())
        track.onended = () => fail(new Error('Camera disconnected. Start it again to retry.'));
      const video = videoRef.current;
      if (!video)
        throw new Error('The camera preview is not mounted. Open the camera view and try again.');
      video.srcObject = media;
      await video.play();
      if (!active()) return;
      setProgress('Preparing the local object detector…');
      timer.current = setTimeout(
        () => fail(new Error('The detector took too long to load. Try again.')),
        45000,
      );
      const model = await loadDetector();
      if (!active()) return;
      if (timer.current) clearTimeout(timer.current);
      setStatus('running');
      setProgress('');
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('This browser cannot read camera frames.');
      const detect = async () => {
        if (!active()) return;
        const began = performance.now();
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            canvas.width = Math.min(480, video.videoWidth);
            canvas.height = Math.max(
              1,
              Math.round((canvas.width * video.videoHeight) / video.videoWidth),
            );
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const predictions = await detectFrame(model, canvas);
            if (!active()) return;
            observations.current = trackObjects(
              observations.current,
              predictions.map((p) => ({
                label: p.class,
                score: p.score,
                x: p.bbox[0] / canvas.width,
                y: p.bbox[1] / canvas.height,
                width: p.bbox[2] / canvas.width,
                height: p.bbox[3] / canvas.height,
              })),
              Date.now(),
            );
            setObjects(observations.current);
            callback.current?.(observations.current);
          }
          // One inference at a time; leave breathing room for the animated scene.
          if (active())
            frame.current = setTimeout(
              () => void detect(),
              Math.max(150, 400 - (performance.now() - began)),
            );
        } catch {
          fail(
            new Error('Object detection stopped. Your camera was released; try starting it again.'),
          );
        }
      };
      void detect();
    } catch (failure) {
      fail(
        failure instanceof DOMException && failure.name === 'NotAllowedError'
          ? new Error(
              'Camera permission was denied. Allow camera access in your browser or system settings, then retry.',
            )
          : failure,
      );
    }
  }, [cleanup]);
  const switchCamera = useCallback(async () => {
    facing.current = facing.current === 'environment' ? 'user' : 'environment';
    await start();
  }, [start]);
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    const leave = () => stop();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', leave);
    return () => {
      cleanup();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', leave);
    };
  }, [cleanup, stop]);
  return { status, error, progress, objects, videoRef, start, stop, switchCamera };
}
