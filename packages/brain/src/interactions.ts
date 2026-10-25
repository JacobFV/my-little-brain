import * as THREE from 'three';
export interface PluginInteraction {
  id: string;
  pluginId: string;
  label: string;
  kind: 'icon' | 'browser' | 'portal';
  status: 'active' | 'complete' | 'error';
  x: number;
  y: number;
  startedAt: number;
  imageUrl?: string;
  /** Stable scene snapshot canvas. Never retained after this interaction is disposed. */
  liveCanvas?: HTMLCanvasElement;
}
export function interactionScale(age: number, exiting: boolean, reducedMotion: boolean) {
  const t = reducedMotion ? 1 : Math.min(1, Math.max(0, age / 500));
  const eased = t * t * (3 - 2 * t);
  return exiting ? 1 - eased : eased;
}
export function interactionPosition(
  camera: THREE.PerspectiveCamera,
  x: number,
  y: number,
  distance: number,
) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, -y), camera);
  const normal = camera.getWorldDirection(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    normal,
    camera.position.clone().addScaledVector(normal, distance),
  );
  return ray.ray.intersectPlane(plane, new THREE.Vector3())!;
}
function roundedPlane(width: number, height: number, radius: number) {
  const s = new THREE.Shape(),
    x = -width / 2,
    y = -height / 2;
  s.moveTo(x + radius, y);
  s.lineTo(x + width - radius, y);
  s.quadraticCurveTo(x + width, y, x + width, y + radius);
  s.lineTo(x + width, y + height - radius);
  s.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  s.lineTo(x + radius, y + height);
  s.quadraticCurveTo(x, y + height, x, y + height - radius);
  s.lineTo(x, y + radius);
  s.quadraticCurveTo(x, y, x + radius, y);
  return new THREE.ShapeGeometry(s);
}
interface Entry {
  data: PluginInteraction;
  group: THREE.Group;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  entered: number;
  exiting?: number;
  image?: HTMLImageElement;
  loadedImage?: HTMLImageElement;
  imageGeneration: number;
  disposed: boolean;
  focus: number;
  focusFrom: number;
  focusTo: number;
  focusStarted: number;
  paintedAt?: number;
}
export function createPluginInteractions() {
  const root = new THREE.Group();
  root.name = 'plugin-interactions';
  const entries = new Map<string, Entry>();
  function paint(entry: Entry, image?: HTMLImageElement) {
    const { canvas, data } = entry,
      ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff9ef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (data.kind === 'portal') {
      ctx.fillStyle = '#e8f0ec';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (data.liveCanvas?.width && data.liveCanvas.height) {
        const scale = Math.min(
          canvas.width / data.liveCanvas.width,
          (canvas.height - 38) / data.liveCanvas.height,
        );
        const width = data.liveCanvas.width * scale,
          height = data.liveCanvas.height * scale;
        ctx.drawImage(
          data.liveCanvas,
          (canvas.width - width) / 2,
          38 + (canvas.height - 38 - height) / 2,
          width,
          height,
        );
      } else {
        ctx.fillStyle = '#657b73';
        ctx.font = '22px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Opening environment…', canvas.width / 2, canvas.height / 2);
      }
      ctx.fillStyle = '#51685f';
      ctx.font = '500 19px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(data.label.slice(0, 45), 18, 27, canvas.width - 50);
    } else if (data.kind === 'browser') {
      ctx.fillStyle = '#ede9e5';
      ctx.fillRect(0, 0, 640, 44);
      ['#e8a5a8', '#e6cb8b', '#a8cbb5'].forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(22 + i * 22, 22, 6, 0, Math.PI * 2);
        ctx.fill();
      });
      if (image) ctx.drawImage(image, 0, 44, 640, 316);
      else {
        ctx.fillStyle = '#887f8e';
        ctx.font = '22px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Opening browser…', 320, 205);
      }
    } else {
      ctx.fillStyle = '#514b56';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (data.pluginId === 'notion') {
        ctx.strokeStyle = '#514b56';
        ctx.lineWidth = 9;
        ctx.strokeRect(72, 56, 112, 112);
        ctx.font = 'bold 110px Georgia';
        ctx.fillText('N', 128, 118);
      } else {
        ctx.font = 'bold 95px system-ui';
        const symbol = data.pluginId.includes('file')
          ? '▤'
          : data.pluginId.includes('computer')
            ? '⌘'
            : data.pluginId.includes('camera')
              ? '◉'
              : data.pluginId.includes('clipboard')
                ? '▣'
                : '✦';
        ctx.fillText(symbol, 128, 111);
      }
      ctx.font = '500 20px system-ui';
      ctx.fillText(data.label.slice(0, 21), 128, 218, 230);
    }
    ctx.fillStyle =
      data.status === 'error' ? '#cb747e' : data.status === 'complete' ? '#91bda0' : '#c8a4d7';
    ctx.beginPath();
    ctx.arc(canvas.width - 18, 18, 7, 0, Math.PI * 2);
    ctx.fill();
    entry.texture.needsUpdate = true;
  }
  function imageUpdate(entry: Entry) {
    const generation = ++entry.imageGeneration;
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image = undefined;
    }
    paint(entry, entry.loadedImage);
    if (!entry.data.imageUrl?.startsWith('data:image/')) return;
    const image = new Image();
    entry.image = image;
    image.onload = () => {
      if (!entry.disposed && generation === entry.imageGeneration) {
        entry.loadedImage = image;
        paint(entry, image);
      }
    };
    image.onerror = () => {
      if (!entry.disposed && generation === entry.imageGeneration) paint(entry);
    };
    image.src = entry.data.imageUrl;
  }
  function dispose(entry: Entry) {
    entry.disposed = true;
    entry.imageGeneration++;
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image.src = '';
    }
    entry.loadedImage = undefined;
    entry.texture.dispose();
    entry.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    root.remove(entry.group);
    entries.delete(entry.data.id);
  }
  return {
    root,
    update(
      items: PluginInteraction[],
      activeId: string | null | undefined,
      camera: THREE.PerspectiveCamera,
      distance: number,
      now: number,
      reducedMotion: boolean,
      focusedId?: string | null,
    ) {
      const bounded = items.slice(-6),
        ids = new Set(bounded.map((item) => item.id));
      for (const data of bounded) {
        let entry = entries.get(data.id);
        if (!entry) {
          const canvas = document.createElement('canvas');
          canvas.width = data.kind !== 'icon' ? 640 : 256;
          canvas.height = data.kind === 'portal' ? 640 : data.kind === 'browser' ? 360 : 256;
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          const group = new THREE.Group();
          group.name = `plugin-${data.id}`;
          group.userData.portal = data.kind === 'portal';
          const width = data.kind !== 'icon' ? 1.05 : 0.42,
            height = data.kind === 'portal' ? 1.05 : data.kind === 'browser' ? 0.62 : 0.46;
          const frame = new THREE.Mesh(
            roundedPlane(width + 0.055, height + 0.055, 0.055),
            new THREE.MeshBasicMaterial({ color: '#d7cddd', side: THREE.DoubleSide }),
          );
          group.add(frame);
          const surface = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshBasicMaterial({
              map: texture,
              toneMapped: false,
              side: THREE.DoubleSide,
            }),
          );
          surface.position.z = 0.006;
          group.add(surface);
          entry = {
            data,
            group,
            canvas,
            texture,
            entered: now,
            imageGeneration: 0,
            disposed: false,
            focus: 0,
            focusFrom: 0,
            focusTo: 0,
            focusStarted: now,
          };
          entries.set(data.id, entry);
          root.add(group);
          imageUpdate(entry);
        } else {
          const changed =
            entry.data.imageUrl !== data.imageUrl ||
            entry.data.status !== data.status ||
            entry.data.label !== data.label ||
            entry.data.liveCanvas !== data.liveCanvas;
          entry.data = data;
          entry.exiting = undefined;
          if (changed) imageUpdate(entry);
        }
        if (data.kind === 'portal' && now - (entry.paintedAt ?? -Infinity) >= 250) {
          paint(entry);
          entry.paintedAt = now;
        }
      }
      let target: THREE.Vector3 | undefined;
      for (const entry of entries.values()) {
        if (!ids.has(entry.data.id)) entry.exiting ??= now;
        const scale = interactionScale(
          now - (entry.exiting ?? entry.entered),
          entry.exiting !== undefined,
          reducedMotion,
        );
        if (entry.exiting !== undefined && scale === 0) {
          dispose(entry);
          continue;
        }
        const nextFocus = entry.data.id === focusedId ? 1 : 0;
        if (nextFocus !== entry.focusTo) {
          entry.focusFrom = entry.focus;
          entry.focusTo = nextFocus;
          entry.focusStarted = now;
        }
        const focusTime = reducedMotion ? 1 : Math.min(1, (now - entry.focusStarted) / 450);
        entry.focus =
          entry.focusFrom +
          (entry.focusTo - entry.focusFrom) * focusTime * focusTime * (3 - 2 * focusTime);
        const focusedDistance = distance * (1 - entry.focus * 0.2);
        const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * focusedDistance;
        const width = entry.data.kind !== 'icon' ? 1.105 : 0.475,
          height =
            entry.data.kind === 'portal' ? 1.105 : entry.data.kind === 'browser' ? 0.675 : 0.515;
        const enlarged = Math.min(
          (viewHeight * camera.aspect * 0.86) / width,
          (viewHeight * 0.8) / height,
        );
        const pos = interactionPosition(
          camera,
          Math.max(-0.9, Math.min(0.9, entry.data.x)) * (1 - entry.focus),
          Math.max(-0.9, Math.min(0.9, entry.data.y)) * (1 - entry.focus),
          focusedDistance,
        );
        entry.group.position.copy(pos);
        entry.group.quaternion.copy(camera.quaternion);
        if (!reducedMotion)
          entry.group.translateY(
            ((1 - scale) * -0.25 + Math.sin(now / 1000 + entry.entered) * 0.012) *
              (1 - entry.focus),
          );
        entry.group.scale.setScalar(scale * (1 + (enlarged - 1) * entry.focus));
        if (entry.data.id === (focusedId ?? activeId) && entry.exiting === undefined)
          target = entry.group.position.clone();
      }
      return target;
    },
    bounds(camera: THREE.PerspectiveCamera) {
      return [...entries.values()].map((entry) => {
        entry.group.updateMatrixWorld(true);
        const width = entry.data.kind !== 'icon' ? 1.105 : 0.475,
          height =
            entry.data.kind === 'portal' ? 1.105 : entry.data.kind === 'browser' ? 0.675 : 0.515;
        const a = entry.group
          .localToWorld(new THREE.Vector3(-width / 2, height / 2, 0))
          .project(camera);
        const b = entry.group
          .localToWorld(new THREE.Vector3(width / 2, -height / 2, 0))
          .project(camera);
        return {
          id: entry.data.id,
          left: (a.x + 1) * 50,
          top: (1 - a.y) * 50,
          width: (b.x - a.x) * 50,
          height: (a.y - b.y) * 50,
        };
      });
    },
    dispose() {
      for (const entry of [...entries.values()]) dispose(entry);
    },
  };
}
