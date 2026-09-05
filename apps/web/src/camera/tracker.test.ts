import { describe, it, expect } from 'vitest';
import { trackObjects, observationSummary } from './tracker';
const person = { label: 'person', score: 0.9, x: 0.1, y: 0.2, width: 0.2, height: 0.4 };
describe('camera observations', () => {
  it('keeps stable IDs while boxes move and suppresses duplicates', () => {
    const first = trackObjects([], [person], 100);
    const next = trackObjects(
      first,
      [
        { ...person, x: 0.12 },
        { ...person, x: 0.121, score: 0.7 },
      ],
      200,
    );
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(first[0].id);
    expect(next[0].seenAt).toBe(200);
  });
  it('keeps separate objects of the same class and expires missing objects', () => {
    const first = trackObjects([], [person, { ...person, x: 0.7 }], 100);
    expect(first).toHaveLength(2);
    expect(first[0].id).not.toBe(first[1].id);
    expect(trackObjects(first, [], 500)).toHaveLength(2);
    expect(trackObjects(first, [], 2200)).toEqual([]);
  });
  it('drops invalid and low confidence predictions and clamps boxes', () => {
    expect(
      trackObjects(
        [],
        [
          { ...person, score: 0.2 },
          { ...person, x: NaN },
        ],
        0,
      ),
    ).toEqual([]);
    const result = trackObjects([], [{ ...person, x: -0.1 }], 0)[0];
    expect(result.x).toBe(0);
    expect(result.width).toBeCloseTo(0.1);
  });
  it('summarizes generic labels and positions without identity guesses', () => {
    const objects = trackObjects([], [person], 100);
    const summary = observationSummary(objects, 100);
    expect(summary).toContain('person');
    expect(summary).toContain(objects[0].id);
    expect(summary).toContain('90%');
    expect(observationSummary(objects, 5000)).toContain('No objects');
  });
});
