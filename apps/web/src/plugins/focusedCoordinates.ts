/** Account for contain-fit letterboxing; plugin input uses the original viewport pixels. */
export function screenPoint(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
) {
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height);
  const left = bounds.left + (bounds.width - viewport.width * scale) / 2,
    top = bounds.top + (bounds.height - viewport.height * scale) / 2;
  const px = (x - left) / scale,
    py = (y - top) / scale;
  return px >= 0 && py >= 0 && px < viewport.width && py < viewport.height
    ? { x: Math.round(px), y: Math.round(py) }
    : null;
}
