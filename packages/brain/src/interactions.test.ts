import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { interactionPosition, interactionScale } from './interactions';
describe('plugin viewing plane', () => {
  it('maps normalized screen coordinates to the foreground plane while orbiting', () => {
    const camera = new THREE.PerspectiveCamera(35, 1.5, 0.1, 50);
    camera.position.set(4, 1, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const world = interactionPosition(camera, 0.4, -0.3, 4);
    const screen = world.clone().project(camera);
    expect(screen.x).toBeCloseTo(0.4);
    expect(screen.y).toBeCloseTo(0.3);
    expect(
      world.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())),
    ).toBeCloseTo(4);
  });
  it('enters and exits by elapsed wall time, respecting reduced motion', () => {
    expect(interactionScale(0, false, false)).toBe(0);
    expect(interactionScale(600, false, false)).toBe(1);
    expect(interactionScale(600, true, false)).toBe(0);
    expect(interactionScale(0, false, true)).toBe(1);
    expect(interactionScale(0, true, true)).toBe(0);
  });
});
