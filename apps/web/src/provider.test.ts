import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTwin, newMessage } from '@little-brain/core';
import { OpenAIRealtimeProvider, type ProviderOptions } from './provider';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: URL) {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  event(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
class Channel extends Socket {
  override readyState: any = 'open';
}
class Peer {
  static instances: Peer[] = [];
  channel = new Channel(new URL('http://localhost'));
  localDescription = { sdp: 'offer' };
  ontrack: ((event: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange = null;
  connectionState = 'connected';
  constructor() {
    Peer.instances.push(this);
  }
  addTrack() {}
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.channel.onopen?.();
  }
  close() {}
}
class AudioElement {
  static instances: AudioElement[] = [];
  autoplay = false;
  muted = false;
  srcObject: unknown = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  constructor() {
    AudioElement.instances.push(this);
  }
}
const options = (mode: 'text' | 'audio' = 'text'): ProviderOptions => ({
  twin: createTwin('Pip'),
  mode,
  endpoint: 'http://localhost:8787',
  token: '',
  onEvent: vi.fn(),
  onStatus: vi.fn(),
  onError: vi.fn(),
});
describe('Realtime provider lifecycle', () => {
  let provider: OpenAIRealtimeProvider;
  beforeEach(() => {
    Socket.instances = [];
    Peer.instances = [];
    AudioElement.instances = [];
    vi.stubGlobal('WebSocket', Socket);
    provider = new OpenAIRealtimeProvider();
  });
  afterEach(() => {
    provider.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('rejects an interrupted text connection without reporting an error for intentional cancellation', async () => {
    const opts = options();
    const connecting = provider.connect(opts);
    const rejected = expect(connecting).rejects.toThrow('Connection cancelled');
    provider.disconnect();
    await rejected;
    expect(opts.onError).not.toHaveBeenCalled();
    expect(opts.onStatus).not.toHaveBeenCalledWith('connected');
  });
  it('does not let stale socket events interfere with a replacement connection', async () => {
    const first = options();
    const pending = provider.connect(first);
    const rejected = expect(pending).rejects.toThrow('Connection cancelled');
    const stale = Socket.instances[0];
    const second = options();
    const replacement = provider.connect(second);
    stale.onopen?.();
    stale.onerror?.();
    stale.event({ type: 'brain.ready' });
    expect(stale.sent).toEqual([]);
    expect(first.onError).not.toHaveBeenCalled();
    Socket.instances[1].event({ type: 'brain.ready' });
    await replacement;
    await rejected;
    expect(second.onStatus).toHaveBeenLastCalledWith('connected');
  });
  it('leaves server rate-limit headroom after replaying long history and sending a new turn', async () => {
    const opts = options();
    opts.twin.messages = Array.from({ length: 90 }, (_, i) => newMessage(`Memory ${i}`));
    const connected = provider.connect(opts);
    const socket = Socket.instances[0];
    socket.onopen?.();
    socket.event({ type: 'brain.ready' });
    await connected;
    provider.sendMessage(newMessage('Next thought'));
    expect(socket.sent).toHaveLength(43);
    expect(socket.sent[1]).toMatchObject({
      type: 'conversation.item.create',
      item: { content: [{ text: expect.stringContaining('Memory 50') }] },
    });
  });
  it('clears interrupted voice output without muting subsequent microphone-only replies', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    vi.stubGlobal('RTCPeerConnection', Peer);
    vi.stubGlobal('Audio', AudioElement);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => 'answer' })),
    );
    const opts = options('audio');
    await provider.connect(opts);
    const peer = Peer.instances[0],
      audio = AudioElement.instances[0];
    peer.ontrack?.({ streams: [{}] });
    provider.cancel();
    expect(peer.channel.sent.map((e) => e.type)).toEqual([
      'response.cancel',
      'output_audio_buffer.clear',
    ]);
    expect(audio.muted).toBe(false);
    peer.channel.event({ type: 'input_audio_buffer.speech_started' });
    peer.channel.event({ type: 'response.created' });
    expect(audio.muted).toBe(false);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(opts.onEvent).toHaveBeenCalledWith({ type: 'response.created' });
  });
  it('rejects cancellation while waiting for microphone permission and stops the late stream', async () => {
    let grant!: (stream: unknown) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    vi.stubGlobal('RTCPeerConnection', Peer);
    const opts = options('audio');
    const connection = provider.connect(opts);
    const rejected = expect(connection).rejects.toThrow('Connection cancelled');
    provider.disconnect();
    grant({ getTracks: () => [{ stop }] });
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(opts.onError).not.toHaveBeenCalled();
    expect(Peer.instances).toHaveLength(0);
  });
  it('times out unanswered microphone permission and releases a later grant', async () => {
    vi.useFakeTimers();
    let grant!: (stream: unknown) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    vi.stubGlobal('RTCPeerConnection', Peer);
    const opts = { ...options('audio'), onProgress: vi.fn() };
    const connection = provider.connect(opts);
    const rejected = expect(connection).rejects.toThrow(/microphone permission.*timed out/i);
    expect(opts.onStatus).toHaveBeenLastCalledWith('connecting');
    expect(opts.onProgress).toHaveBeenCalledWith(expect.stringMatching(/microphone permission/i));
    await vi.advanceTimersByTimeAsync(30001);
    await rejected;
    expect(opts.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(opts.onError).toHaveBeenCalledOnce();
    grant({ getTracks: () => [{ stop }] });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(Peer.instances).toHaveLength(0);
  });
  it('settles cancellation without waiting for microphone permission', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(() => {}) } });
    vi.stubGlobal('RTCPeerConnection', Peer);
    const opts = options('audio');
    let settled = false;
    const connection = provider.connect(opts).catch(() => {
      settled = true;
    });
    provider.disconnect();
    await connection;
    expect(settled).toBe(true);
    expect(opts.onError).not.toHaveBeenCalled();
  });
  it('times out stalled voice negotiation and stops microphone capture', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal('RTCPeerConnection', Peer);
    vi.stubGlobal('Audio', AudioElement);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const opts = options('audio');
    const rejected = expect(provider.connect(opts)).rejects.toThrow(/voice connection timed out/i);
    await vi.advanceTimersByTimeAsync(30001);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(opts.onStatus).toHaveBeenLastCalledWith('disconnected');
  });
  it.each([
    ['NotAllowedError', /microphone permission was denied/i],
    ['NotFoundError', /no microphone/i],
    ['NotReadableError', /another app|in use/i],
  ])('explains microphone %s failures', async (name, message) => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => {
          throw new DOMException('Opaque browser error', name);
        },
      },
    });
    vi.stubGlobal('RTCPeerConnection', Peer);
    const opts = options('audio');
    await expect(provider.connect(opts)).rejects.toThrow(message);
    expect(opts.onError).toHaveBeenCalledWith(expect.stringMatching(message));
  });
  it('reports a closed voice channel while session negotiation is still pending', async () => {
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal('RTCPeerConnection', Peer);
    vi.stubGlobal('Audio', AudioElement);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const opts = options('audio');
    const rejected = expect(provider.connect(opts)).rejects.toThrow(/voice channel closed/i);
    await Promise.resolve();
    Peer.instances[0].channel.close();
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(opts.onError).toHaveBeenCalledWith(expect.stringMatching(/voice channel closed/i));
    expect(opts.onStatus).toHaveBeenLastCalledWith('disconnected');
  });
  it('explains when microphone capture is unavailable without creating a voice peer', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('RTCPeerConnection', Peer);
    const opts = options('audio');
    await expect(provider.connect(opts)).rejects.toThrow(/secure browser|desktop app/i);
    expect(Peer.instances).toHaveLength(0);
    expect(opts.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(opts.onError).toHaveBeenCalledOnce();
  });
});
