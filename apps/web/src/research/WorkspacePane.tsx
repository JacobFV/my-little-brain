import { useRef, type PointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './ui';

/** Both side panes belong to the same workspace and use the same sizing and chrome. */
export function WorkspacePane({
  side,
  title,
  width,
  onResize,
  onClose,
  children,
  actions,
}: {
  side: 'left' | 'right';
  title: string;
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const pane = useRef<HTMLElement>(null);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const origin = event.clientX,
      initial = width;
    const move = (current: globalThis.PointerEvent) =>
      onResize(
        Math.max(
          side === 'left' ? 210 : 300,
          Math.min(
            side === 'left' ? 360 : 560,
            initial + (current.clientX - origin) * (side === 'left' ? 1 : -1),
          ),
        ),
      );
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  return (
    <aside
      ref={pane}
      className={`workspace-pane pane-${side}`}
      style={{ width }}
      aria-label={title}
    >
      <header className="pane-heading">
        <h2>{title}</h2>
        <div>
          {actions}
          <IconButton label={`Close ${title.toLowerCase()} pane`} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="pane-content">{children}</div>
      <div
        className={`pane-resize resize-${side}`}
        role="separator"
        aria-label={`Resize ${title.toLowerCase()} pane`}
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={side === 'left' ? 210 : 300}
        aria-valuemax={side === 'left' ? 360 : 560}
        tabIndex={0}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            onResize(
              Math.max(
                side === 'left' ? 210 : 300,
                Math.min(
                  side === 'left' ? 360 : 560,
                  width + (event.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1),
                ),
              ),
            );
          }
        }}
      />
    </aside>
  );
}
