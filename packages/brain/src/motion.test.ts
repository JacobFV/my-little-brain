import { describe, expect, it } from 'vitest';
import { dragOrbit, returnOrbit } from './motion';
describe('camera orbit', () => {
  const state = { yaw: 1, pitch: 0.5, lastInput: 100, dragging: false };
  it('lets users inspect for four seconds after their latest input', () => {
    expect(returnOrbit(state, 4099, 0.016, false)).toBe(state);
    expect(returnOrbit({ ...state, dragging: true }, 9000, 0.016, false).yaw).toBe(1);
    expect(returnOrbit(state, 4101, 0.016, false).yaw).toBeLessThan(1);
  });
  it('returns exactly home without animation for reduced motion', () => {
    expect(returnOrbit(state, 4100, 0.016, true)).toMatchObject({ yaw: 0, pitch: 0 });
  });
  it('reaches home after six seconds even if rendering was suspended', () => {
    expect(returnOrbit(state, 6100, 0.016, false)).toMatchObject({ yaw: 0, pitch: 0 });
    expect(returnOrbit(state, 20100, 0.04, false)).toMatchObject({ yaw: 0, pitch: 0 });
  });
  it('uses wall time so low and high frame rates have identical return angles', () => {
    const sparse = returnOrbit(state, 5100, 0.04, false);
    let frequent = state;
    for (let now = 4110; now <= 5100; now += 10) frequent = returnOrbit(frequent, now, 0.01, false);
    expect(sparse.yaw).toBeCloseTo(frequent.yaw, 8);
    expect(sparse.pitch).toBeCloseTo(frequent.pitch, 8);
  });
  it('wraps horizontal rotation and prevents inversion at either pole', () => {
    const moved = dragOrbit(state, 10000, 10000, 200);
    expect(Math.abs(moved.yaw)).toBeLessThanOrEqual(Math.PI);
    expect(moved.pitch).toBe(1.05);
    expect(moved.lastInput).toBe(200);
    expect(moved.dragging).toBe(true);
  });
});
