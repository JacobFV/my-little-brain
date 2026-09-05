import { expect, it } from 'vitest';
import { screenPoint } from './focusedCoordinates';
it('maps touch points through letterboxing and ignores outer margins', () => {
  const bounds = { left: 10, top: 20, width: 400, height: 400 },
    viewport = { width: 1000, height: 500 };
  expect(screenPoint(210, 220, bounds, viewport)).toEqual({ x: 500, y: 250 });
  expect(screenPoint(210, 40, bounds, viewport)).toBe(null);
});
