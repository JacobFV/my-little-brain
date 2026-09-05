// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { environmentImage } from './environmentImage';
afterEach(() => vi.restoreAllMocks());
it('limits provider snapshots to 640 pixels and uses compressed JPEG', () => {
  const context = { fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
    format,
    quality,
  ) {
    expect(this.width).toBe(640);
    expect(this.height).toBe(320);
    expect(format).toBe('image/jpeg');
    expect(quality).toBe(0.65);
    return 'data:image/jpeg;base64,snapshot';
  });
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 960;
  expect(environmentImage(canvas)).toBe('data:image/jpeg;base64,snapshot');
  expect(encode).toHaveBeenCalledOnce();
  expect(context.drawImage).toHaveBeenCalledWith(canvas, 0, 0, 640, 320);
});
it('falls back to text when no readable frame is available', () => {
  expect(environmentImage()).toBeUndefined();
  const context = { fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
    throw new Error('Tainted');
  });
  expect(environmentImage(document.createElement('canvas'))).toBeUndefined();
});
