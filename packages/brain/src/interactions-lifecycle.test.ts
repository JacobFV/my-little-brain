// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createPluginInteractions, type PluginInteraction } from './interactions';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('renders the live peer canvas in a square portal at a bounded refresh rate and releases its texture', () => {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.z = 7;
  camera.updateMatrixWorld();
  const liveCanvas = document.createElement('canvas');
  liveCanvas.width = 500;
  liveCanvas.height = 250;
  const manager = createPluginInteractions();
  const item: PluginInteraction = {
    id: 'portal',
    pluginId: 'portal',
    kind: 'portal',
    label: 'B’s environment',
    status: 'active',
    x: 0.5,
    y: 0.2,
    startedAt: 0,
    liveCanvas,
  };
  manager.update([item], item.id, camera, 4, 0, true);
  const entry = manager.root.children[0];
  expect(entry.userData.portal).toBe(true);
  expect(ctx.drawImage).toHaveBeenLastCalledWith(liveCanvas, 0, 179, 640, 320);
  const draws = ctx.drawImage.mock.calls.length;
  manager.update([item], item.id, camera, 4, 100, true);
  expect(ctx.drawImage).toHaveBeenCalledTimes(draws);
  manager.update([item], item.id, camera, 4, 250, true);
  expect(ctx.drawImage).toHaveBeenCalledTimes(draws + 1);
  const surface = entry.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  expect(surface.geometry.parameters.width).toBe(surface.geometry.parameters.height);
  const dispose = vi.spyOn(surface.material.map!, 'dispose');
  manager.update([], null, camera, 4, 500, true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(manager.root.children).toHaveLength(0);
  manager.dispose();
});
it('ignores superseded image loads and disposes removed screen textures', () => {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  const images: Array<{ onload: null | (() => void); onerror: null | (() => void); src: string }> =
    [];
  vi.stubGlobal(
    'Image',
    class {
      onload = null;
      onerror = null;
      src = '';
      constructor() {
        images.push(this);
      }
    },
  );
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.z = 7;
  camera.updateMatrixWorld();
  const manager = createPluginInteractions();
  const item: PluginInteraction = {
    id: 'a',
    pluginId: 'browser',
    kind: 'browser',
    label: 'Browser',
    status: 'active',
    x: 0.5,
    y: 0.2,
    startedAt: 0,
    imageUrl: 'data:image/png;base64,first',
  };
  manager.update([item], 'a', camera, 4, 0, false);
  const oldLoad = images[0].onload!;
  manager.update(
    [{ ...item, imageUrl: 'data:image/png;base64,second' }],
    'a',
    camera,
    4,
    10,
    false,
  );
  oldLoad();
  expect(ctx.drawImage).not.toHaveBeenCalled();
  images[1].onload!();
  expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  const screen = manager.root.children[0].children[1] as THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.MeshBasicMaterial
  >;
  const dispose = vi.spyOn(screen.material.map!, 'dispose');
  manager.update([], null, camera, 4, 20, false);
  expect(manager.root.children).toHaveLength(1);
  const lateLoad = images[1].onload!;
  manager.update([], null, camera, 4, 600, false);
  expect(manager.root.children).toHaveLength(0);
  expect(dispose).toHaveBeenCalledOnce();
  lateLoad();
  expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  manager.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});
it('focuses the same instance nearly full screen and restores its dragged position', () => {
  const ctx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  const camera = new THREE.PerspectiveCamera(35, 1.5, 0.1, 50);
  camera.position.set(4, 1, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const manager = createPluginInteractions();
  const item: PluginInteraction = {
    id: 'b',
    pluginId: 'browser',
    kind: 'browser',
    label: 'Browser',
    status: 'active',
    x: 0.6,
    y: 0.3,
    startedAt: 0,
  };
  manager.update([item], 'b', camera, 4, 0, true);
  const instance = manager.root.children[0];
  const original = manager.bounds(camera)[0];
  expect(original.left + original.width / 2).toBeCloseTo(80);
  manager.update([item], 'b', camera, 4, 100, true, 'b');
  const focused = manager.bounds(camera)[0];
  expect(focused.left + focused.width / 2).toBeCloseTo(50);
  expect(focused.top + focused.height / 2).toBeCloseTo(50);
  expect(focused.width).toBeGreaterThan(70);
  expect(focused.width).toBeLessThanOrEqual(86.01);
  expect(focused.height).toBeLessThanOrEqual(80.01);
  manager.update([{ ...item, x: -0.4 }], 'b', camera, 4, 200, true, null);
  const moved = manager.bounds(camera)[0];
  expect(moved.left + moved.width / 2).toBeCloseTo(30);
  expect(manager.root.children[0]).toBe(instance);
  manager.dispose();
});
