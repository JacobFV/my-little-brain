import { useEffect, useState, type CSSProperties } from 'react';
import { Camera, CameraOff, RefreshCw, SwitchCamera } from 'lucide-react';
import type { CameraHandle } from './useCamera';
import './camera.css';
export function CameraPreview({ camera, style }: { camera: CameraHandle; style?: CSSProperties }) {
  const [ratio, setRatio] = useState(4 / 3);
  const active = camera.status === 'running' || camera.status === 'loading';
  // A preview can be removed by navigation while the owning App stays mounted.
  useEffect(() => () => camera.stop(), [camera.stop]);
  return (
    <section className="camera-preview" style={style} aria-label="Camera observations">
      <div className="camera-preview-header">
        <span>
          <Camera size={15} /> Camera
        </span>
        <span className={`camera-state ${camera.status}`}>
          {camera.status === 'running'
            ? 'LIVE'
            : camera.status === 'loading'
              ? 'STARTING'
              : camera.status === 'error'
                ? 'UNAVAILABLE'
                : 'CAMERA OFF'}
        </span>
      </div>
      <div className="camera-feed" style={{ aspectRatio: ratio }}>
        <video
          ref={camera.videoRef}
          muted
          playsInline
          aria-label="Live camera preview"
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            if (video.videoWidth) setRatio(video.videoWidth / video.videoHeight);
          }}
        />
        {camera.status === 'running' &&
          camera.objects.map((object) => (
            <div
              className="camera-box"
              key={object.id}
              style={{
                left: `${object.x * 100}%`,
                top: `${object.y * 100}%`,
                width: `${object.width * 100}%`,
                height: `${object.height * 100}%`,
              }}
            >
              <span>
                {object.label} <b>{Math.round(object.score * 100)}%</b>
              </span>
            </div>
          ))}
        {camera.status !== 'running' && (
          <div className="camera-empty">
            {camera.status === 'loading' ? (
              <RefreshCw className="camera-spinner" size={24} />
            ) : (
              <CameraOff size={27} />
            )}
            <p role={camera.status === 'error' ? 'alert' : 'status'}>
              {camera.status === 'loading'
                ? camera.progress
                : camera.status === 'error'
                  ? camera.error
                  : 'Let your brain notice everyday objects around you.'}
            </p>
          </div>
        )}
      </div>
      <div className="camera-preview-controls">
        <span>
          {camera.status === 'running'
            ? `${camera.objects.length} ${camera.objects.length === 1 ? 'object' : 'objects'} noticed`
            : 'You choose when to look.'}
        </span>
        <div>
          {active && (
            <button
              type="button"
              title="Switch camera"
              aria-label="Switch camera"
              onClick={() => void camera.switchCamera()}
            >
              <SwitchCamera size={16} />
            </button>
          )}
          <button
            type="button"
            className={active ? '' : 'camera-start'}
            onClick={() => (active ? camera.stop() : void camera.start())}
          >
            {active ? <CameraOff size={15} /> : <Camera size={15} />}{' '}
            {active ? 'Stop camera' : camera.status === 'error' ? 'Try again' : 'Start camera'}
          </button>
        </div>
      </div>
      <p className="camera-privacy">
        Frames stay on this device; object labels are shared with your brain. Labels may be wrong.
      </p>
    </section>
  );
}
