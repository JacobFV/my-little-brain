import type { Twin, Message, RealtimeEvent } from '@little-brain/core';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type ProviderOptions = {
  twin: Twin;
  mode: 'text' | 'audio';
  endpoint: string;
  token: string;
  onEvent: (event: RealtimeEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError: (message: string) => void;
  onProgress?: (message: string) => void;
};
// UI depends on this boundary; another model can implement the same contract later.
export interface BrainProvider {
  connect(options: ProviderOptions): Promise<void>;
  sendMessage(message: Message): void;
  sendEvent(event: object): void;
  cancel(): void;
  disconnect(): void;
}
export class OpenAIRealtimeProvider implements BrainProvider {
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private options: ProviderOptions | null = null;
  private connectingReject: ((reason: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  async connect(options: ProviderOptions): Promise<void> {
    this.disconnect();
    const generation = ++this.generation;
    this.options = options;
    options.onStatus('connecting');
    this.abort = new AbortController();
    const onError = (error: unknown) => {
      if (generation !== this.generation) throw new Error('Connection cancelled.');
      const message = error instanceof Error ? error.message : 'Could not connect to your brain.';
      this.disconnect();
      options.onError(message);
      throw new Error(message);
    };
    try {
      const interrupted = new Promise<never>((_, reject) => {
        this.connectingReject = reject;
        this.timer = setTimeout(
          () =>
            reject(
              new Error(
                options.mode === 'audio'
                  ? this.stream
                    ? 'Voice connection timed out. Check the connection in Settings and try again.'
                    : 'Microphone permission request timed out. Check the browser permission prompt, then try again.'
                  : 'Connection timed out. Check your server and try again.',
              ),
            ),
          30000,
        );
      });
      await Promise.race([
        options.mode === 'text'
          ? this.connectText(options, generation)
          : this.connectVoice(options, generation),
        interrupted,
      ]);
      if (generation !== this.generation) throw new Error('Connection cancelled.');
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.connectingReject = null;
      // Replay a bounded recent history when reconnecting or switching voice/text.
      let budget = 48000;
      const history: Message[] = [];
      for (const m of [...options.twin.messages].reverse()) {
        if (!m.text || m.status === 'failed') continue;
        if (budget - m.text.length < 0 || history.length >= 40) break;
        budget -= m.text.length;
        history.unshift(m);
      }
      for (const m of history)
        this.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: m.role,
            content: [
              {
                type: m.role === 'user' ? 'input_text' : 'output_text',
                text: `[thought_id: ${m.id}]\n${m.text}`,
              },
            ],
          },
        });
      options.onProgress?.('');
      options.onStatus('connected');
    } catch (error) {
      return onError(error);
    }
  }
  private connectText(options: ProviderOptions, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/realtime', options.endpoint || location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        if (generation !== this.generation) return;
        socket.send(
          JSON.stringify({
            type: 'connect',
            token: options.token,
            brain: { name: options.twin.name, personality: options.twin.personality },
          }),
        );
      };
      socket.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        let event: RealtimeEvent;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (event.type === 'brain.ready') {
          resolve();
          return;
        }
        if (event.type === 'brain.error') {
          const error = new Error(String(event.message));
          if (this.connectingReject) {
            reject(error);
          } else options.onError(error.message);
          return;
        }
        options.onEvent(event);
      };
      socket.onerror = () => {
        if (generation !== this.generation) return;
        if (this.connectingReject)
          reject(new Error('Cannot reach the brain server. Check the connection in Settings.'));
        else options.onError('Connection to the brain server was lost.');
      };
      socket.onclose = () => {
        if (generation === this.generation) {
          if (this.connectingReject)
            reject(new Error('The brain session ended before it was ready.'));
          else {
            this.disconnect();
            options.onError('Session ended. Send a message to reconnect.');
          }
        }
      };
    });
  }
  private async connectVoice(options: ProviderOptions, generation: number): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection)
      throw new Error('Voice needs microphone access in a secure browser or the desktop app.');
    options.onProgress?.('Requesting microphone permission… Check your browser permission prompt.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (failure) {
      const name = failure && typeof failure === 'object' && 'name' in failure ? failure.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError')
        throw new Error(
          'Microphone permission was denied. Allow microphone access in your browser or system settings, then retry.',
        );
      if (name === 'NotFoundError')
        throw new Error('No microphone was found. Connect a microphone and try again.');
      if (name === 'NotReadableError' || name === 'AbortError')
        throw new Error(
          'The microphone is unavailable or in use by another app. Check system microphone access and try again.',
        );
      throw failure;
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Connection cancelled.');
    }
    this.stream = stream;
    options.onProgress?.('Connecting voice to your brain…');
    const peer = new RTCPeerConnection();
    this.peer = peer;
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    const audio = new Audio();
    audio.autoplay = true;
    this.audio = audio;
    peer.ontrack = (event) => {
      if (generation !== this.generation) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio
        .play()
        .catch(() =>
          options.onError('Audio playback is blocked. Tap the voice button to reconnect.'),
        );
    };
    peer.onconnectionstatechange = () => {
      if (
        generation === this.generation &&
        ['failed', 'disconnected'].includes(peer.connectionState)
      ) {
        this.disconnect();
        options.onError('Voice connection was lost. Tap the microphone to reconnect.');
      }
    };
    const channel = peer.createDataChannel('oai-events');
    this.channel = channel;
    channel.onmessage = ({ data }) => {
      if (generation !== this.generation) return;
      try {
        const event = JSON.parse(data);
        if (event.type === 'error') options.onError('The voice request failed. Try reconnecting.');
        else options.onEvent(event);
      } catch {
        /* Ignore malformed provider events. */
      }
    };
    const opened = new Promise<void>((resolve, reject) => {
      channel.onopen = () => {
        if (generation !== this.generation) return;
        resolve();
      };
      channel.onclose = () => {
        if (generation === this.generation) {
          if (this.connectingReject) {
            const error = new Error('Voice channel closed.');
            reject(error);
            this.connectingReject(error);
          } else {
            this.disconnect();
            options.onError('Voice session ended. Tap the microphone to reconnect.');
          }
        }
      };
    });
    // Attach rejection immediately so an SDP failure cannot leave an unhandled promise.
    void opened.catch(() => {});
    const offer = await peer.createOffer();
    if (generation !== this.generation) throw new Error('Connection cancelled.');
    await peer.setLocalDescription(offer);
    if (generation !== this.generation) throw new Error('Connection cancelled.');
    const response = await fetch(new URL('/api/session', options.endpoint || location.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({
        sdp: peer.localDescription?.sdp,
        brain: { name: options.twin.name, personality: options.twin.personality },
      }),
      signal: this.abort?.signal,
    });
    if (generation !== this.generation) throw new Error('Connection cancelled.');
    if (!response.ok) {
      let message = 'Could not start voice.';
      try {
        message = (await response.json()).error || message;
      } catch {}
      throw new Error(message);
    }
    const sdp = await response.text();
    if (generation !== this.generation) throw new Error('Connection cancelled.');
    await peer.setRemoteDescription({ type: 'answer', sdp });
    await opened;
  }
  sendEvent(event: object) {
    const data = JSON.stringify(event);
    if (this.channel?.readyState === 'open') this.channel.send(data);
    else if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
    else throw new Error('Your brain is not connected yet.');
  }
  sendMessage(message: Message) {
    if (this.audio) {
      this.audio.muted = false;
      void this.audio.play().catch(() => {});
    }
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[thought_id: ${message.id}]\n${message.text}` }],
      },
    });
    this.sendEvent({ type: 'response.create' });
  }
  cancel() {
    try {
      this.sendEvent({ type: 'response.cancel' });
      if (this.channel) this.sendEvent({ type: 'output_audio_buffer.clear' });
    } catch {}
  }
  disconnect() {
    this.generation++;
    this.connectingReject?.(new Error('Connection cancelled.'));
    this.connectingReject = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.socket?.close();
    this.socket = null;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.options?.onProgress?.('');
    this.options?.onStatus('disconnected');
    this.options = null;
  }
}
