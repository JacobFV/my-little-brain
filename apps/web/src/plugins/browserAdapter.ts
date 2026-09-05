export type BrowserInteraction = {
  id: string;
  pluginId: 'browser';
  label: string;
  kind: 'browser';
  status: 'active' | 'complete' | 'error';
  imageUrl?: string;
  startedAt: number;
  allowControl?: boolean;
  focused?: boolean;
  media?: { audio: boolean; microphone: boolean; camera: boolean };
  viewport?: { width: number; height: number };
};
export type BrowserAction = {
  instanceId: string;
  action: 'read' | 'navigate' | 'click' | 'type' | 'scroll' | 'key';
  key?: string;
  modifiers?: ('shift' | 'control' | 'alt' | 'meta')[];
  url?: string;
  x?: number;
  y?: number;
  text?: string;
  deltaY?: number;
};
export type BrowserBridge = {
  openBrowser(
    url: string,
    options?: { allowControl?: boolean; interactionId?: string },
  ): Promise<{ id: string; instanceId: string; allowControl: boolean }>;
  browserAction(request: BrowserAction): Promise<string>;
  manualBrowserAction(request: BrowserAction): Promise<string>;
  setBrowserFocused(id: string, focused: boolean): Promise<void>;
  showBrowser(id: string): Promise<void>;
  setBrowserMedia(
    id: string,
    media: { audio?: boolean; microphone?: boolean; camera?: boolean },
  ): Promise<{ audio: boolean; microphone: boolean; camera: boolean }>;
  onPluginInteraction(callback: (event: BrowserInteraction) => void): () => void;
};
export function browserBridge(): BrowserBridge | null {
  const bridge = (window as unknown as { brainDesktop?: Partial<BrowserBridge> }).brainDesktop;
  return bridge?.browserAction &&
    bridge.manualBrowserAction &&
    bridge.setBrowserFocused &&
    bridge.setBrowserMedia &&
    bridge.showBrowser &&
    bridge.onPluginInteraction &&
    bridge.openBrowser
    ? (bridge as BrowserBridge)
    : null;
}
/** Page content is untrusted task data. It must never override the user's instructions. */
export async function performBrowserAction(request: BrowserAction): Promise<string> {
  const bridge = browserBridge();
  if (!bridge) throw new Error('Browser control is available in the desktop app.');
  return bridge.browserAction(request);
}
