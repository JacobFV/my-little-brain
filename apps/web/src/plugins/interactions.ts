import { thoughtPosition } from '@little-brain/core';
export type PluginInteraction = {
  id: string;
  twinId: string;
  pluginId: string;
  label: string;
  kind: 'icon' | 'browser' | 'portal';
  liveCanvas?: HTMLCanvasElement;
  status: 'active' | 'complete' | 'error';
  x: number;
  y: number;
  startedAt: number;
  imageUrl?: string;
  viewport?: { width: number; height: number };
  media?: { audio: boolean; microphone: boolean; camera: boolean };
};
export function createInteraction(
  twinId: string,
  pluginId: string,
  label: string,
  kind: PluginInteraction['kind'] = 'icon',
  id: string = crypto.randomUUID(),
): PluginInteraction {
  const point = thoughtPosition(id);
  return {
    id,
    twinId,
    pluginId,
    label,
    kind,
    status: 'active',
    x: point.x * 0.55,
    y: point.y * 0.45,
    startedAt: Date.now(),
  };
}
export function mergeInteraction(
  values: PluginInteraction[],
  next: PluginInteraction,
): PluginInteraction[] {
  const previous = values.find((value) => value.id === next.id);
  if (previous && previous.status !== 'active') return values;
  return [
    ...values.filter((value) => value.id !== next.id),
    { ...next, startedAt: previous?.startedAt ?? next.startedAt },
  ].slice(-12);
}
