import type { ObjectDetection } from '@tensorflow-models/coco-ssd';
let cached: Promise<ObjectDetection> | null = null;
let inference: Promise<unknown> = Promise.resolve();
export function detectFrame(model: ObjectDetection, canvas: HTMLCanvasElement) {
  const next = inference.catch(() => {}).then(() => model.detect(canvas, 16, 0.55));
  inference = next;
  return next;
}
// Only weights are downloaded. Camera pixels never leave this browser.
export function loadDetector(): Promise<ObjectDetection> {
  if (!cached) {
    cached = (async () => {
      const tf = await import('@tensorflow/tfjs-core');
      await Promise.all([
        import('@tensorflow/tfjs-backend-cpu'),
        import('@tensorflow/tfjs-backend-webgl'),
      ]);
      try {
        if (!(await tf.setBackend('webgl'))) await tf.setBackend('cpu');
      } catch {
        await tf.setBackend('cpu');
      }
      await tf.ready();
      const coco = await import('@tensorflow-models/coco-ssd');
      return coco.load({
        base: 'lite_mobilenet_v2',
        modelUrl: new URL('/vision/model.json', location.origin).href,
      });
    })().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
