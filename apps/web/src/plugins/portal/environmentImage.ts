/** Ephemeral model input, created only when a connected peer takes a turn. */
export function environmentImage(canvas?: HTMLCanvasElement | null): string | undefined {
  if (!canvas?.width || !canvas.height) return undefined;
  const snapshot = document.createElement('canvas');
  const scale = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
  snapshot.width = Math.max(1, Math.round(canvas.width * scale));
  snapshot.height = Math.max(1, Math.round(canvas.height * scale));
  const context = snapshot.getContext('2d');
  if (!context) return undefined;
  try {
    context.fillStyle = '#edf2ed';
    context.fillRect(0, 0, snapshot.width, snapshot.height);
    context.drawImage(canvas, 0, 0, snapshot.width, snapshot.height);
    return snapshot.toDataURL('image/jpeg', 0.65);
  } catch {
    // A temporarily unavailable or tainted browser surface has no image input.
    return undefined;
  }
}
