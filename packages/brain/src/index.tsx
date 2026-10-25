import { useEffect, useRef, useState, type PointerEvent } from 'react';
import * as THREE from 'three';
import { createBrain } from './model';
import { createDistraction, type DistractionKind } from './distraction';
import { createPluginInteractions, type PluginInteraction } from './interactions';
export type { PluginInteraction } from './interactions';
import { dragOrbit, returnOrbit, type OrbitState } from './motion';
import { disposeAnatomy, loadAnatomy, setAnatomyMode } from './anatomy';

export interface BrainSceneProps {
  thoughts: Array<{ id: string; text: string; x: number; y: number }>;
  activeThoughtId: string | null;
  thinking: boolean;
  paused: boolean;
  showThoughts: boolean;
  onThoughtSelect: (id: string) => void;
  onThoughtMove?: (id: string, x: number, y: number) => void;
  color?: string;
  reducedMotion?: boolean;
  anatomyMode?: boolean;
  energy?: number;
  pluginInteractions?: PluginInteraction[];
  focusedPluginInteractionId?: string | null;
  onPluginMove?: (id: string, x: number, y: number) => void;
  onPluginFocus?: (id: string) => void;
  activePluginInteractionId?: string | null;
  distraction?: DistractionKind | null;
  /** Hackathon-only illustrative field propagation; not anatomical source localization. */
  researchOverlay?: { intensities: number[]; opacity: number; shellOpacity?: number };
  /** At most four frames/second, copied to a stable canvas. Portal surfaces are
   * excluded from snapshots, bounding reciprocal viewing to one environment. */
  onFrame?: (canvas: HTMLCanvasElement) => void;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Normalized thought coordinates use screen space: positive y points downward. */
export function BrainScene(props: BrainSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const pluginButtons = useRef(new Map<string, HTMLButtonElement>());
  const researchButtons = useRef(new Map<number, HTMLButtonElement>());
  const pluginDrag = useRef<{
    id: string;
    pointer: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const current = useRef(props);
  current.current = props;
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [anatomyState, setAnatomyState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
      });
    } catch {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.style.cssText =
      'width:100%;height:100%;display:block;touch-action:none;cursor:grab';
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    camera.position.set(0, -0.12, 7.1);
    camera.lookAt(0, -0.12, 0);
    scene.add(new THREE.HemisphereLight('#fffefa', '#bdab9a', 1.45));
    const key = new THREE.DirectionalLight('#fff7ee', 3.2);
    key.position.set(-3, 4, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -2;
    key.shadow.camera.right = 2;
    key.shadow.camera.top = 2;
    key.shadow.camera.bottom = -2;
    key.shadow.normalBias = 0.018;
    key.shadow.bias = -0.0002;
    scene.add(key);
    const fill = new THREE.DirectionalLight('#f1f7ff', 1.1);
    fill.position.set(3, 1, 3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight('#ffe1dc', 2.4);
    rim.position.set(1, 3, -3);
    scene.add(rim);
    const { group, eyes, eyeRoots, cortex, subcortex } = createBrain(props.color);
    group.visible = false;
    scene.add(group);
    // Cortex² research overlay: translucent stylized pathways and traveling activity pulses.
    // These coordinates are anatomical illustrations, not EEG inverse localizations.
    const activityNodes = [
      [-0.53, 0.38, 0.20], [0.53, 0.38, 0.20],
      [-0.74, 0.03, -0.08], [0.74, 0.03, -0.08],
      [-0.36, 0.03, 0.43], [0.36, 0.03, 0.43],
      [-0.35, -0.31, -0.38], [0.35, -0.31, -0.38],
    ].map((v) => new THREE.Vector3(...(v as [number, number, number])));
    const activityRoot = new THREE.Group();
    group.add(activityRoot);
    const activityBeads: THREE.Mesh[] = [];
    const activityEdges: Array<{ mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3; a: number; b: number; pulse: THREE.Mesh }> = [];
    const activityLinks = [[0,4],[1,5],[2,4],[3,5],[4,6],[5,7],[4,5],[0,1],[6,7],[2,6],[3,7]];
    for (const [a,b] of activityLinks) {
      const start = activityNodes[a], end = activityNodes[b];
      const curve = new THREE.CatmullRomCurve3([
        start, start.clone().lerp(end, .35).add(new THREE.Vector3(0,.18,-.12)),
        start.clone().lerp(end,.67).add(new THREE.Vector3(0,-.13,.08)), end,
      ]);
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 32, .008, 6, false),
        new THREE.MeshBasicMaterial({color:'#65a8ab',transparent:true,opacity:.22,depthWrite:false}),
      );
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(.028, 10, 8),
        new THREE.MeshBasicMaterial({color:'#e4ae69',transparent:true,opacity:.5,depthWrite:false}),
      );
      activityRoot.add(mesh,pulse);
      activityEdges.push({mesh,curve,a,b,pulse});
    }
    for (const point of activityNodes) {
      const bead = new THREE.Mesh(
        new THREE.SphereGeometry(.046, 12, 10),
        new THREE.MeshBasicMaterial({color:'#80d1bb',transparent:true,opacity:.75,depthWrite:false}),
      );
      bead.position.copy(point);
      activityRoot.add(bead);
      activityBeads.push(bead);
    }
    const distraction = createDistraction();
    scene.add(distraction.root);
    const pluginInteractions = createPluginInteractions();
    scene.add(pluginInteractions.root);
    const raycaster = new THREE.Raycaster();
    let orbit: OrbitState = { yaw: 0, pitch: 0, lastInput: 0, dragging: false };
    let pointer: { id: number; x: number; y: number } | null = null;
    let cameraRadius = 7.1;
    const orbitStart = (event: globalThis.PointerEvent) => {
      if (event.button !== 0 || pointer || current.current.paused) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      orbit.dragging = true;
      orbit.returnFrom = undefined;
      orbit.lastInput = performance.now();
      renderer.domElement.setPointerCapture(event.pointerId);
      renderer.domElement.style.cursor = 'grabbing';
    };
    const orbitMove = (event: globalThis.PointerEvent) => {
      if (pointer?.id !== event.pointerId) return;
      orbit = dragOrbit(
        orbit,
        event.clientX - pointer.x,
        event.clientY - pointer.y,
        performance.now(),
      );
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    const orbitEnd = (event: globalThis.PointerEvent) => {
      if (pointer?.id !== event.pointerId) return;
      pointer = null;
      orbit.dragging = false;
      orbit.lastInput = performance.now();
      renderer.domElement.style.cursor = 'grab';
      if (renderer.domElement.hasPointerCapture(event.pointerId))
        renderer.domElement.releasePointerCapture(event.pointerId);
    };
    const orbitKeyboard = (event: KeyboardEvent) => {
      if (event.target !== element || current.current.paused) return;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-20, 0],
        ArrowRight: [20, 0],
        ArrowUp: [0, -20],
        ArrowDown: [0, 20],
      };
      if (event.key === 'Home') {
        event.preventDefault();
        orbit = { yaw: 0, pitch: 0, lastInput: performance.now(), dragging: false };
      } else if (moves[event.key]) {
        event.preventDefault();
        orbit = { ...dragOrbit(orbit, ...moves[event.key], performance.now()), dragging: false };
      }
    };
    element.addEventListener('keydown', orbitKeyboard);
    renderer.domElement.addEventListener('pointerdown', orbitStart);
    renderer.domElement.addEventListener('pointermove', orbitMove);
    renderer.domElement.addEventListener('pointerup', orbitEnd);
    renderer.domElement.addEventListener('pointercancel', orbitEnd);
    renderer.domElement.addEventListener('lostpointercapture', orbitEnd);
    let disposed = false;
    let anatomyMode = Boolean(current.current.anatomyMode);
    let lastShellOpacity = -1;
    const loading = new AbortController();
    setAnatomyState('loading');
    void loadAnatomy(loading.signal, props.color)
      .then((loaded) => {
        if (disposed) {
          disposeAnatomy(loaded.cortex);
          disposeAnatomy(loaded.subcortex);
          return;
        }
        cortex.add(loaded.cortex);
        subcortex.add(loaded.subcortex);
        setAnatomyMode(cortex, subcortex, anatomyMode);
        // On the lab route, the original meshes are drawn as a see-through shell.
        // Material instances come from the separately loaded anatomy assets.
        if (current.current.researchOverlay) {
          for (const root of [loaded.cortex, loaded.subcortex])
            root.traverse((obj) => {
              if (!(obj instanceof THREE.Mesh)) return;
              for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
                material.transparent = true;
                material.opacity = .28;
                material.depthWrite = false;
                material.needsUpdate = true;
              }
            });
        }
        group.visible = true;
        setAnatomyState('ready');
      })
      .catch(() => {
        if (!disposed) setAnatomyState('error');
      });
    let contextLost = false;
    let frame = 0;
    let previous = 0;
    let elapsed = 0;
    let gazeX = 0,
      gazeY = 0,
      velocityX = 0,
      velocityY = 0;
    const snapshot = document.createElement('canvas');
    const snapshotContext = snapshot.getContext('2d');
    let lastSnapshot = -Infinity;
    const resize = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      if (!width || !height || disposed) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Preserve the entire anatomy on narrow mobile viewports.
      cameraRadius = Math.max(7.1, 4.5 / camera.aspect);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const lose = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      setUnavailable(true);
    };
    const restore = () => {
      contextLost = false;
      setUnavailable(false);
      resize();
    };
    renderer.domElement.addEventListener('webglcontextlost', lose);
    renderer.domElement.addEventListener('webglcontextrestored', restore);
    const render = (now: number) => {
      if (disposed) return;
      const dt = Math.min((now - (previous || now)) / 1000, 0.04);
      previous = now;
      const p = current.current;
      if (Boolean(p.anatomyMode) !== anatomyMode) {
        anatomyMode = Boolean(p.anatomyMode);
        setAnatomyMode(cortex, subcortex, anatomyMode);
      }
      const overlay = p.researchOverlay;
      if (overlay) {
        const shellOpacity = clamp(overlay.shellOpacity ?? .28, .08, 1);
        if (Math.abs(lastShellOpacity - shellOpacity) > .001) {
          lastShellOpacity = shellOpacity;
          for (const root of [cortex, subcortex]) root.traverse(obj => {
            if (!(obj instanceof THREE.Mesh)) return;
            for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
              material.transparent = shellOpacity < .999;
              material.opacity = shellOpacity;
              material.depthWrite = shellOpacity >= .999;
              material.needsUpdate = true;
            }
          });
        }
      }
      activityRoot.visible = Boolean(overlay);
      if (overlay) {
        const opacity = clamp(overlay.opacity, 0, 1);
        for (let i = 0; i < activityBeads.length; i++) {
          const intensity = clamp(overlay.intensities[i] ?? 0, 0, 1);
          const bead = activityBeads[i];
          bead.scale.setScalar(.65 + .9 * intensity);
          const material = bead.material as THREE.MeshBasicMaterial;
          material.opacity = opacity * (.3 + .7 * intensity);
        }
        for (let i = 0; i < activityEdges.length; i++) {
          const edge = activityEdges[i];
          const signal = clamp(((overlay.intensities[edge.a] ?? 0)+(overlay.intensities[edge.b] ?? 0)) / 2,0,1);
          (edge.mesh.material as THREE.MeshBasicMaterial).opacity = opacity * (.16 + .58*signal);
          (edge.pulse.material as THREE.MeshBasicMaterial).opacity = opacity * (.28 + .65*signal);
          const progress = ((now * (.00016 + signal*.00015) + i*.117) % 1);
          edge.pulse.position.copy(edge.curve.getPoint(progress));
          edge.pulse.scale.setScalar(.55 + signal);
        }
      }
      const energy = clamp(p.energy ?? 1, 0, 1);
      if (!p.paused) {
        orbit = returnOrbit(orbit, now, dt, Boolean(p.reducedMotion));
        camera.position.set(
          Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * cameraRadius,
          Math.sin(orbit.pitch) * cameraRadius - 0.12,
          Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * cameraRadius,
        );
        camera.lookAt(0, -0.12, 0);
        camera.updateMatrixWorld();
        distraction.update(p.distraction, elapsed, Boolean(p.reducedMotion), energy);
      }
      const pluginTarget = pluginInteractions.update(
        p.pluginInteractions ?? [],
        p.activePluginInteractionId,
        camera,
        cameraRadius - 2.4,
        now,
        Boolean(p.reducedMotion),
        p.focusedPluginInteractionId,
      );
      for (const bounds of pluginInteractions.bounds(camera)) {
        const button = pluginButtons.current.get(bounds.id);
        if (!button) continue;
        button.style.left = `${bounds.left}%`;
        button.style.top = `${bounds.top}%`;
        button.style.width = `${bounds.width}%`;
        button.style.height = `${bounds.height}%`;
      }
      const target = p.thoughts.find((thought) => thought.id === p.activeThoughtId);
      const targetX = target?.x ?? 0,
        targetY = target?.y ?? 0;
      if (!p.paused) {
        elapsed += dt;
        if (p.reducedMotion) {
          gazeX = targetX;
          gazeY = targetY;
          velocityX = 0;
          velocityY = 0;
        } else {
          // Small substeps keep the damped attention spring stable at any frame rate.
          const steps = Math.max(1, Math.ceil(dt / 0.008));
          for (let i = 0; i < steps; i++) {
            const step = dt / steps;
            velocityX +=
              ((targetX - gazeX) * (28 + 36 * energy) - velocityX * (10 + 5 * energy)) * step;
            velocityY +=
              ((targetY - gazeY) * (28 + 36 * energy) - velocityY * (10 + 5 * energy)) * step;
            gazeX += velocityX * step;
            gazeY += velocityY * step;
          }
        }
        const motion = p.reducedMotion ? 0 : 1;
        group.position.y =
          Math.sin(elapsed * (0.7 + energy * 0.45)) * 0.033 * motion * (0.3 + 0.7 * energy);
        group.rotation.y = (Math.sin(elapsed * 0.35) * 0.026 + gazeX * 0.055) * motion;
        const breath = 1 + Math.sin(elapsed * 1.7) * 0.006 * motion;
        group.scale.set(breath, breath, breath);
        // Convert the invisible foreground glass from screen to world space,
        // so gaze still follows HTML thoughts while the camera is orbited.
        raycaster.setFromCamera(new THREE.Vector2(gazeX, -gazeY), camera);
        const planeNormal = camera.getWorldDirection(new THREE.Vector3());
        const glassCenter = camera.position
          .clone()
          .addScaledVector(planeNormal, cameraRadius - 2.4);
        const glass = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, glassCenter);
        const gazeTarget = new THREE.Vector3();
        raycaster.ray.intersectPlane(glass, gazeTarget);
        if (pluginTarget) gazeTarget.copy(pluginTarget);
        else if (!p.activeThoughtId && p.distraction) gazeTarget.copy(distraction.root.position);
        group.updateWorldMatrix(true, false);
        group.worldToLocal(gazeTarget);
        const blinkPhase = elapsed % (p.thinking ? 3.2 : 5.6);
        const blink =
          !p.reducedMotion && blinkPhase > 0.1 && blinkPhase < 0.24
            ? Math.max(0.08, Math.abs(blinkPhase - 0.17) / 0.07)
            : 1;
        for (let i = 0; i < eyes.length; i++) {
          const direction = gazeTarget.clone().sub(eyeRoots[i].position);
          eyes[i].rotation.set(
            clamp(-Math.atan2(direction.y, direction.z), -0.43, 0.43),
            clamp(Math.atan2(direction.x, direction.z), -0.58, 0.58),
            0,
          );
          eyes[i].scale.y = blink;
        }
      }
      if (p.researchOverlay) {
        activityRoot.updateWorldMatrix(true, false);
        for (let i=0; i<activityNodes.length; i++) {
          const marker=researchButtons.current.get(i);
          if (!marker) continue;
          const projected=activityNodes[i].clone().applyMatrix4(activityRoot.matrixWorld).project(camera);
          marker.hidden=projected.z>1 || projected.z< -1 || Math.abs(projected.x)>1 || Math.abs(projected.y)>1;
          marker.style.left=`${(projected.x+1)*50}%`;
          marker.style.top=`${(1-projected.y)*50}%`;
        }
      }
      if (p.paused) for (const eye of eyes) eye.scale.y = 1;
      if (!contextLost) {
        if (p.onFrame && group.visible && snapshotContext && now - lastSnapshot >= 250) {
          lastSnapshot = now;
          const portals = pluginInteractions.root.children.filter((child) => child.userData.portal);
          for (const portal of portals) portal.visible = false;
          renderer.render(scene, camera);
          const scale = Math.min(
            1,
            640 / Math.max(renderer.domElement.width, renderer.domElement.height),
          );
          const width = Math.max(1, Math.round(renderer.domElement.width * scale));
          const height = Math.max(1, Math.round(renderer.domElement.height * scale));
          if (snapshot.width !== width || snapshot.height !== height) {
            snapshot.width = width;
            snapshot.height = height;
          }
          snapshotContext.fillStyle = '#edf2ed';
          snapshotContext.fillRect(0, 0, width, height);
          snapshotContext.drawImage(renderer.domElement, 0, 0, width, height);
          // Thoughts live in HTML in the interactive scene. Include their current
          // positions and text in the portal's view of that same environment.
          if (p.showThoughts)
            for (const thought of p.thoughts) {
              const x = clamp(((thought.x + 1) * width) / 2, 6, width - 150);
              const y = clamp(((thought.y + 1) * height) / 2, 18, height - 18);
              snapshotContext.fillStyle = '#ffffffeb';
              snapshotContext.fillRect(x, y - 12, 144, 25);
              snapshotContext.fillStyle = '#53665a';
              snapshotContext.font = '10px system-ui';
              snapshotContext.fillText(thought.text.slice(0, 28), x + 6, y + 4, 132);
            }
          for (const portal of portals) portal.visible = true;
          p.onFrame(snapshot);
        }
        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      disposed = true;
      loading.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('keydown', orbitKeyboard);
      renderer.domElement.removeEventListener('pointerdown', orbitStart);
      renderer.domElement.removeEventListener('pointermove', orbitMove);
      renderer.domElement.removeEventListener('pointerup', orbitEnd);
      renderer.domElement.removeEventListener('pointercancel', orbitEnd);
      renderer.domElement.removeEventListener('lostpointercapture', orbitEnd);
      renderer.domElement.removeEventListener('webglcontextlost', lose);
      renderer.domElement.removeEventListener('webglcontextrestored', restore);
      pluginInteractions.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            materials.add(material);
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      key.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [props.color, retry]);

  const moveThought = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (drag.current?.id !== id || !props.onThoughtMove || !host.current) return;
    if (
      Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) < 4 &&
      !drag.current.moved
    )
      return;
    drag.current.moved = true;
    const rect = host.current.getBoundingClientRect();
    props.onThoughtMove(
      id,
      clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -0.9, 0.9),
      clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -0.85, 0.85),
    );
  };

  return (
    <div
      ref={host}
      className="brain-scene"
      role="group"
      tabIndex={0}
      aria-label="Your little brain. Drag or use arrow keys to orbit. Home faces forward. The view returns forward after four seconds."
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 280,
        isolation: 'isolate',
      }}
    >
      {props.researchOverlay && <div aria-label="research brain activity markers" style={{position:'absolute',inset:0,pointerEvents:'none',zIndex:4}}>
        {['frontal left','frontal right','temporal left','temporal right','parietal left','parietal right','occipital left','occipital right'].map((name,i) =>
          <button key={name} ref={node=>{if(node)researchButtons.current.set(i,node);else researchButtons.current.delete(i);}}
            type="button" title={`${name}: ${((props.researchOverlay?.intensities[i] ?? 0)*100).toFixed(1)}% normalized synthetic feature proxy`}
            aria-label={`${name}: ${((props.researchOverlay?.intensities[i] ?? 0)*100).toFixed(1)}% activity`}
            style={{position:'absolute',pointerEvents:'auto',transform:'translate(-50%,-50%)',
              width:12,height:12,padding:0,borderRadius:'50%',border:'1px solid #73a9a7',
              background:'#9bdccc',boxShadow:'0 0 0 5px #74c3b325',cursor:'help'}}/>
        )}
      </div>}
      <style>{`
      .brain-plugin-hit { position:absolute;z-index:3;border:0;background:transparent;border-radius:14px;touch-action:none;cursor:grab;min-width:24px;min-height:24px;padding:0; }
      .brain-plugin-hit:focus-visible {outline:2px solid #9372ab;outline-offset:4px;}
      .brain-plugin-hit:active {cursor:grabbing;}
      .brain-thought { position:absolute; z-index:2; max-width:180px; transform:translate(-50%,-50%); padding:10px 14px; border:1px solid #d3e3d6; border-radius:14px; background:rgba(255,255,255,.88); color:#53665a; font:500 11px/1.5 inherit; font-family:inherit; font-size:11px; line-height:1.5; box-shadow:0 4px 20px #28453508; cursor:grab; touch-action:none; backdrop-filter:blur(10px); text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .brain-thought[aria-pressed=true] { border-color:#83a58b; background:#f3faf1; box-shadow:0 0 0 3px #99bc921c; }
      .brain-thought:focus-visible { outline:2px solid #62866b; outline-offset:4px; }
      .brain-thought:active { cursor:grabbing; }
      .brain-fallback { position:absolute; inset:0; display:grid; align-content:center; justify-items:center; color:#81746f; gap:16px; font:12px/1.5 system-ui; }
      .brain-anatomy-note { position:absolute; bottom:12px; left:50%; transform:translateX(-50%); white-space:nowrap; font:10px/1.4 system-ui; color:#778177; opacity:.8; }
    `}</style>
      {props.pluginInteractions?.slice(-6).map((item) => (
        <button
          key={item.id}
          className="brain-plugin-hit"
          ref={(node) => {
            if (node) pluginButtons.current.set(item.id, node);
            else pluginButtons.current.delete(item.id);
          }}
          aria-label={`${item.label}: ${item.status}. Open or drag to move.`}
          aria-pressed={props.focusedPluginInteractionId === item.id}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) props.onPluginFocus?.(item.id);
          }}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              props.onPluginMove?.(
                item.id,
                clamp(
                  item.x +
                    (event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0),
                  -0.9,
                  0.9,
                ),
                clamp(
                  item.y + (event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0),
                  -0.9,
                  0.9,
                ),
              );
            }
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.button !== 0) return;
            pluginDrag.current = {
              id: item.id,
              pointer: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              originX: item.x,
              originY: item.y,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            event.stopPropagation();
            const drag = pluginDrag.current;
            if (
              !drag ||
              drag.id !== item.id ||
              drag.pointer !== event.pointerId ||
              !host.current ||
              props.focusedPluginInteractionId === item.id
            )
              return;
            const dx = event.clientX - drag.x,
              dy = event.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 5) return;
            drag.moved = true;
            const bounds = host.current.getBoundingClientRect();
            props.onPluginMove?.(
              item.id,
              clamp(drag.originX + (dx / bounds.width) * 2, -0.9, 0.9),
              clamp(drag.originY + (dy / bounds.height) * 2, -0.9, 0.9),
            );
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            const drag = pluginDrag.current;
            if (!drag || drag.pointer !== event.pointerId) return;
            pluginDrag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (!drag.moved) props.onPluginFocus?.(item.id);
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            pluginDrag.current = null;
          }}
          onLostPointerCapture={() => {
            pluginDrag.current = null;
          }}
        />
      ))}
      {(props.pluginInteractions?.length ?? 0) > 0 && (
        <span
          role="status"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clipPath: 'inset(50%)',
          }}
        >
          {props.pluginInteractions
            ?.slice(-6)
            .map((item) => `${item.label}: ${item.status}`)
            .join('. ')}
        </span>
      )}
      {unavailable && (
        <div className="brain-fallback" role="status">
          <span style={{ fontSize: 90 }} aria-hidden="true">
            🧠
          </span>
          <span>3D view is unavailable. Your conversations are ready.</span>
        </div>
      )}
      {!unavailable && anatomyState === 'loading' && (
        <div className="brain-fallback" role="status">
          Loading the brain’s anatomy…
        </div>
      )}
      {!unavailable && anatomyState === 'error' && (
        <div className="brain-fallback" role="status">
          <span>The anatomy could not be loaded.</span>
          <button onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </div>
      )}
      {!unavailable && anatomyState === 'ready' && props.anatomyMode && (
        <a
          className="brain-anatomy-note"
          href="/anatomy/README.txt"
          target="_blank"
          rel="noreferrer"
        >
          fsaverage cortex · ENIGMA subcortex · template anatomy
        </a>
      )}
      {props.showThoughts &&
        props.thoughts.map((thought) => (
          <button
            key={thought.id}
            className="brain-thought"
            title={thought.text}
            aria-label={`Focus on thought: ${thought.text}`}
            aria-pressed={thought.id === props.activeThoughtId}
            style={{
              left: `${(thought.x + 1) * 50}%`,
              top: `${(thought.y + 1) * 50}%`,
              transform: `translate(${thought.x < -0.45 ? '0' : thought.x > 0.45 ? '-100%' : '-50%'}, -50%)`,
            }}
            onClick={() => {
              if (!drag.current?.moved) props.onThoughtSelect(thought.id);
              drag.current = null;
            }}
            onPointerDown={(event) => {
              drag.current = { id: thought.id, x: event.clientX, y: event.clientY, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => moveThought(event, thought.id)}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            {thought.text}
          </button>
        ))}
    </div>
  );
}

export default BrainScene;
