import { describe, expect, it } from 'vitest';
import { advanceEnergy, distractionFor } from './energy';
describe('attention energy', () => {
  it('drains when idle, replenishes with observations or work and never exceeds bounds', () => {
    expect(advanceEnergy(0.6, 10, false, false, false)).toBeCloseTo(0.54);
    expect(advanceEnergy(0.6, 10, false, true, false)).toBeCloseTo(0.78);
    expect(advanceEnergy(0.9, 10, true, false, false)).toBe(1);
    expect(advanceEnergy(0.01, 10, false, false, false)).toBe(0);
  });
  it('caps elapsed time after suspension and preserves focus during deliberate rest', () => {
    expect(advanceEnergy(1, 86400, false, false, false)).toBeCloseTo(0.64);
    expect(advanceEnergy(0.2, 10, false, false, true)).toBeCloseTo(0.2);
  });
  it('manifests progressively stronger distractions at low energy', () => {
    expect([0.8, 0.4, 0.3, 0.1].map(distractionFor)).toEqual([null, 'mote', 'butterfly', 'fly']);
  });
});
