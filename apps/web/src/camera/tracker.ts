export type Detection = {
  label: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type CameraObject = Detection & { id: string; seenAt: number };
export const OBJECT_TTL = 1600;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function overlap(a: Detection, b: Detection) {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / (a.width * a.height + b.width * b.height - area || 1);
}
export function trackObjects(
  previous: CameraObject[],
  detections: Detection[],
  now = Date.now(),
): CameraObject[] {
  const candidates = detections
    .filter(
      (d) =>
        [d.x, d.y, d.width, d.height, d.score].every(Number.isFinite) &&
        d.score >= 0.55 &&
        d.width > 0 &&
        d.height > 0 &&
        d.label.length < 80,
    )
    .map((d) => ({
      ...d,
      x: clamp(d.x),
      y: clamp(d.y),
      width: clamp(d.x + d.width) - clamp(d.x),
      height: clamp(d.y + d.height) - clamp(d.y),
    }))
    .filter((d) => d.width > 0 && d.height > 0)
    .sort((a, b) => b.score - a.score);
  const unique: Detection[] = [];
  for (const d of candidates) {
    if (!unique.some((o) => o.label === d.label && overlap(o, d) > 0.65)) unique.push(d);
  }
  const remaining = previous.filter((o) => now - o.seenAt < OBJECT_TTL);
  const result: CameraObject[] = [];
  for (const d of unique.slice(0, 16)) {
    let best = -1,
      score = 0.2;
    remaining.forEach((o, i) => {
      const match = o.label === d.label ? overlap(o, d) : 0;
      if (match > score) {
        score = match;
        best = i;
      }
    });
    const old = best >= 0 ? remaining.splice(best, 1)[0] : null;
    result.push({ ...d, id: old?.id ?? `vision-${crypto.randomUUID()}`, seenAt: now });
  }
  return [...result, ...remaining].slice(0, 20);
}
export function observationSummary(objects: CameraObject[], now = Date.now()): string {
  const visible = objects.filter((o) => now - o.seenAt < OBJECT_TTL).slice(0, 12);
  if (!visible.length) return 'Camera is on. No objects confidently detected in the current view.';
  return `Current camera observations from a local object detector (approximate, may be wrong; labels do not identify people):\n${visible.map((o) => `[thought_id: ${o.id}] ${o.label}, ${Math.round(o.score * 100)}% confidence, center (${Math.round((o.x + o.width / 2) * 100)}%, ${Math.round((o.y + o.height / 2) * 100)}%) from top-left`).join('\n')}`;
}
export const summarizeObservations = observationSummary;
