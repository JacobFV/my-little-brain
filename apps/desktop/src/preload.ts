import { contextBridge, ipcRenderer } from 'electron';
const restored: unknown = ipcRenderer.sendSync('brain:restore-storage');
if (restored && typeof restored === 'object') {
  for (const [key, value] of Object.entries(restored)) {
    if (
      key.startsWith('little-brain.') &&
      !/token|secret|api.?key/i.test(key) &&
      typeof value === 'string'
    )
      localStorage.setItem(key, value);
  }
}
let lastSaved = '';
const persist = () => {
  if (!restored || typeof restored !== 'object') return;
  const values: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('little-brain.') && !/token|secret|api.?key/i.test(key))
      values[key] = localStorage.getItem(key)!;
  }
  const serialized = JSON.stringify(values);
  if (serialized !== lastSaved && ipcRenderer.sendSync('brain:save-storage', values))
    lastSaved = serialized;
};
window.addEventListener('DOMContentLoaded', () => {
  setInterval(persist, 1000);
});
window.addEventListener('beforeunload', persist);
contextBridge.exposeInMainWorld(
  'brainDesktop',
  Object.freeze({
    platform: process.platform,
    openBrowser: (url: string, options?: { allowControl?: boolean; interactionId?: string }) =>
      ipcRenderer.invoke('brain:open-browser', url, options),
    browserAction: (request: unknown) => ipcRenderer.invoke('brain:browser-action', request),
    manualBrowserAction: (request: unknown) =>
      ipcRenderer.invoke('brain:manual-browser-action', request),
    setBrowserFocused: (id: string, focused: boolean) =>
      ipcRenderer.invoke('brain:set-browser-focused', id, focused),
    showBrowser: (id: string) => ipcRenderer.invoke('brain:show-browser', id),
    setBrowserMedia: (id: string, media: unknown) =>
      ipcRenderer.invoke('brain:set-browser-media', id, media),
    onPluginInteraction: (callback: (value: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
      ipcRenderer.on('brain:plugin-interaction', listener);
      return () => ipcRenderer.removeListener('brain:plugin-interaction', listener);
    },
    minimize: () => ipcRenderer.send('brain:minimize'),
    toggleMaximize: () => ipcRenderer.send('brain:toggle-maximize'),
    close: () => ipcRenderer.send('brain:close'),
  }),
);
