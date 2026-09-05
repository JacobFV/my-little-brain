type NativeReply = { requestId: string; raw?: string | null; error?: string };
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

export function nativeStorageRequest(
  action: 'read' | 'write' | 'export',
  raw?: string,
): Promise<NativeReply> {
  return new Promise((resolve, reject) => {
    const bridge = window.ReactNativeWebView;
    if (!bridge) {
      resolve({ requestId: '', raw: null });
      return;
    }
    const requestId = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('little-brain.native-response', listener);
    };
    const listener = (event: Event) => {
      const reply = (event as CustomEvent<NativeReply>).detail;
      if (reply?.requestId !== requestId) return;
      cleanup();
      reply.error ? reject(new Error(reply.error)) : resolve(reply);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Native backup did not respond. Export a backup before closing.'));
    }, 8000);
    window.addEventListener('little-brain.native-response', listener);
    bridge.postMessage(
      JSON.stringify({ type: 'brain:workspace', action, requestId, origin: location.origin, raw }),
    );
  });
}
