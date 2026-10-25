// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTwin, newMessage, type Twin } from '@little-brain/core';
import type { ProviderOptions } from './provider';
import { useBrain } from './useBrain';

const transport = vi.hoisted(() => ({
  options: null as ProviderOptions | null,
  resolve: null as (() => void) | null,
  sendMessage: vi.fn(),
  sendEvent: vi.fn(),
  cancel: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('./provider', () => ({
  OpenAIRealtimeProvider: class {
    connect(options: ProviderOptions) {
      transport.options = options;
      options.onStatus('connecting');
      return new Promise<void>((resolve) => {
        transport.resolve = () => {
          options.onStatus('connected');
          resolve();
        };
      });
    }
    sendMessage = transport.sendMessage;
    sendEvent = transport.sendEvent;
    cancel = transport.cancel;
    disconnect = transport.disconnect;
  },
}));
const settings = {
  showThoughts: false,
  reducedMotion: false,
  endpoint: '',
  token: '',
  chatWidth: 360,
};
describe('useBrain lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.options = null;
    transport.resolve = null;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const setup = (initial = createTwin('Pip')) => {
    let twin = initial;
    const update = vi.fn((id: string, change: (t: Twin) => Twin) => {
      if (id === twin.id) twin = change(twin);
    });
    const hook = renderHook(({ selected }) => useBrain(selected, update, settings, vi.fn()), {
      initialProps: { selected: initial },
    });
    return { ...hook, update, getTwin: () => twin };
  };
  it('Stop prevents a pending initial connection from sending the queued text', async () => {
    const hook = setup();
    let sent!: Promise<boolean>;
    act(() => {
      sent = hook.result.current.send('Hello');
    });
    expect(hook.result.current.status).toBe('connecting');
    act(() => hook.result.current.stop());
    await act(async () => {
      transport.resolve?.();
      expect(await sent).toBe(false);
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe('disconnected');
    expect(hook.getTwin().activity.some((a) => a.text === 'Connected to OpenAI Realtime.')).toBe(
      false,
    );
  });
  it('ignores a stale voice connection and callbacks after changing twins', async () => {
    const hook = setup();
    let connecting!: Promise<void>;
    act(() => {
      connecting = hook.result.current.toggleVoice();
    });
    const oldOptions = transport.options!;
    const oldResolve = transport.resolve!;
    hook.rerender({ selected: createTwin('Other') });
    hook.update.mockClear();
    await act(async () => {
      oldResolve();
      await connecting;
      oldOptions.onEvent({ type: 'response.created' });
      oldOptions.onError('Old failure');
    });
    expect(hook.result.current.voice).toBe(false);
    expect(hook.result.current.status).toBe('disconnected');
    expect(hook.result.current.error).toBe('');
    expect(hook.result.current.thinking).toBe(false);
    expect(hook.update).not.toHaveBeenCalled();
  });
  it('relies on server VAD interruption and accepts the next voice response after Stop', async () => {
    const hook = setup();
    let connecting!: Promise<void>;
    act(() => {
      connecting = hook.result.current.toggleVoice();
    });
    await act(async () => {
      transport.resolve?.();
      await connecting;
    });
    act(() => transport.options!.onEvent({ type: 'input_audio_buffer.speech_started' }));
    expect(transport.cancel).not.toHaveBeenCalled();
    act(() => transport.options!.onEvent({ type: 'response.created' }));
    act(() => hook.result.current.stop());
    expect(transport.cancel).toHaveBeenCalledOnce();
    act(() => transport.options!.onEvent({ type: 'response.created' }));
    expect(hook.result.current.thinking).toBe(true);
    expect(hook.result.current.voice).toBe(true);
  });
  it('preserves a tool-selected thought across assistant tokens and resets it at the next user turn', async () => {
    const twin = createTwin('Pip');
    twin.messages = [newMessage('Remember the garden', 'user', 'garden')];
    const hook = setup(twin);
    let connecting!: Promise<void>;
    act(() => {
      connecting = hook.result.current.toggleVoice();
    });
    await act(async () => {
      transport.resolve?.();
      await connecting;
    });
    act(() =>
      transport.options!.onEvent({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'focus_thought',
              arguments: '{"thought_id":"garden"}',
              call_id: 'call',
            },
          ],
        },
      }),
    );
    act(() =>
      transport.options!.onEvent({
        type: 'response.output_audio_transcript.delta',
        item_id: 'reply',
        delta: 'Your garden',
      }),
    );
    expect(hook.result.current.activeThoughtId).toBe('garden');
    act(() => transport.options!.onEvent({ type: 'input_audio_buffer.speech_started' }));
    act(() =>
      transport.options!.onEvent({
        type: 'response.output_audio_transcript.delta',
        item_id: 'next-reply',
        delta: 'New thought',
      }),
    );
    expect(hook.result.current.activeThoughtId).toBe('next-reply');
  });
  it('forwards microphone commit events before the later assistant response', async () => {
    const hook = setup();
    let connecting!: Promise<void>;
    act(() => {
      connecting = hook.result.current.toggleVoice();
    });
    await act(async () => {
      transport.resolve?.();
      await connecting;
    });
    act(() =>
      transport.options!.onEvent({ type: 'input_audio_buffer.committed', item_id: 'spoken' }),
    );
    act(() =>
      transport.options!.onEvent({
        type: 'response.output_audio_transcript.delta',
        item_id: 'reply',
        delta: 'Hello',
      }),
    );
    expect(hook.getTwin().messages.map((m) => m.id)).toEqual(['spoken', 'reply']);
  });
  it('shows microphone startup progress and clears it on cancellation', async () => {
    const hook = setup();
    let connecting!: Promise<void>;
    act(() => {
      connecting = hook.result.current.toggleVoice();
    });
    expect(hook.result.current.voiceConnecting).toBe(true);
    act(() => transport.options!.onProgress?.('Requesting microphone permission…'));
    expect(hook.result.current.voiceProgress).toMatch(/microphone permission/i);
    await act(async () => {
      await hook.result.current.toggleVoice();
    });
    expect(hook.result.current.voiceConnecting).toBe(false);
    expect(hook.result.current.voiceProgress).toBe('');
    await act(async () => {
      transport.resolve?.();
      await connecting;
    });
    expect(hook.result.current.voice).toBe(false);
  });
  it('turns off the active voice state when its connection ends', async () => {
    const hook = setup();
    let connecting!: Promise<void>;
    act(() => {
      connecting = hook.result.current.toggleVoice();
    });
    await act(async () => {
      transport.resolve?.();
      await connecting;
    });
    expect(hook.result.current.voice).toBe(true);
    act(() => {
      transport.options!.onStatus('disconnected');
      transport.options!.onError('Voice connection was lost.');
    });
    expect(hook.result.current.voice).toBe(false);
    expect(hook.result.current.voiceConnecting).toBe(false);
    expect(hook.result.current.error).toMatch(/connection was lost/i);
  });
});

describe('camera context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.options = null;
    transport.resolve = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const setup = () =>
    renderHook(() => useBrain(createTwinStable, updateStable, settings, chatStable));
  const createTwinStable = createTwin('Pip'),
    updateStable = vi.fn(),
    chatStable = vi.fn();
  const connect = async (hook: { result: { current: ReturnType<typeof useBrain> } }) => {
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.toggleVoice();
    });
    await act(async () => {
      transport.resolve?.();
      await pending;
    });
  };
  const items = () => transport.sendEvent.mock.calls.map(([event]) => event);
  it('queues only the latest snapshot for connection without creating an unsolicited response', async () => {
    const hook = setup();
    act(() => {
      hook.result.current.updateVisualContext('Old object', ['vision-old']);
      hook.result.current.updateVisualContext('vision-cup: cup at left', ['vision-cup']);
    });
    expect(items()).toEqual([]);
    await connect(hook);
    expect(items()).toEqual([
      expect.objectContaining({
        type: 'conversation.item.create',
        item: expect.objectContaining({
          role: 'system',
          content: [
            { type: 'input_text', text: expect.stringContaining('Untrusted observations') },
          ],
        }),
      }),
    ]);
    expect(items()[0].item.id.length).toBeLessThanOrEqual(32);
    expect(items()[0].item.content[0].text).toContain('vision-cup: cup at left');
  });
  it('coalesces updates to one replacement each three seconds and deletes the item when camera clears', async () => {
    const hook = setup();
    await connect(hook);
    act(() => hook.result.current.updateVisualContext('First', ['vision-first']));
    const firstId = items()[0].item.id;
    act(() => {
      hook.result.current.updateVisualContext('Second', ['vision-second']);
      hook.result.current.updateVisualContext('Latest', ['vision-latest']);
    });
    expect(items()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2999));
    expect(items()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(items()).toHaveLength(3);
    expect(items()[1]).toEqual({ type: 'conversation.item.delete', item_id: firstId });
    expect(items()[2].item.content[0].text).toContain('Latest');
    act(() => hook.result.current.updateVisualContext('', []));
    expect(items()[3]).toEqual({ type: 'conversation.item.delete', item_id: items()[2].item.id });
    act(() => vi.advanceTimersByTime(3000));
    expect(items()).toHaveLength(4);
  });
  it('makes the newest throttled snapshot available before sending a user question', async () => {
    const hook = setup();
    await connect(hook);
    act(() => hook.result.current.updateVisualContext('First', ['vision-first']));
    act(() => hook.result.current.updateVisualContext('Latest', ['vision-latest']));
    let sending!: Promise<boolean>;
    act(() => {
      sending = hook.result.current.send('What can you see?');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      expect(await sending).toBe(true);
    });
    expect(items().at(-1).item.content[0].text).toContain('Latest');
    expect(transport.sendMessage).toHaveBeenCalledOnce();
  });
  it('replays the latest snapshot after reconnect without deleting an item from the previous session', async () => {
    const hook = setup();
    await connect(hook);
    act(() => hook.result.current.updateVisualContext('Cup', ['vision-cup']));
    act(() => hook.result.current.disconnect());
    transport.sendEvent.mockClear();
    await connect(hook);
    expect(items()).toHaveLength(1);
    expect(items()[0].type).toBe('conversation.item.create');
    expect(items()[0].item.content[0].text).toContain('Cup');
  });
  it('clears camera snapshots and their pending timers on twin switch', async () => {
    const initial = createTwin('First');
    const hook = renderHook(({ twin }) => useBrain(twin, updateStable, settings, chatStable), {
      initialProps: { twin: initial },
    });
    await connect(hook);
    act(() => {
      hook.result.current.updateVisualContext('First view', ['vision-first']);
      hook.result.current.updateVisualContext('Pending view', ['vision-pending']);
    });
    hook.rerender({ twin: createTwin('Second') });
    transport.sendEvent.mockClear();
    await connect(hook);
    act(() => vi.advanceTimersByTime(3000));
    expect(items()).toEqual([]);
  });
  it('accepts only current observation IDs for gaze and clears focus when the observation disappears', async () => {
    const hook = setup();
    await connect(hook);
    act(() => hook.result.current.updateVisualContext('Cup', ['vision-cup']));
    const focus = (id: string) =>
      transport.options!.onEvent({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'focus_thought',
              arguments: JSON.stringify({ thought_id: id }),
              call_id: crypto.randomUUID(),
            },
          ],
        },
      });
    act(() => focus('vision-cup'));
    expect(hook.result.current.activeThoughtId).toBe('vision-cup');
    act(() => hook.result.current.updateVisualContext('', []));
    expect(hook.result.current.activeThoughtId).toBe(null);
    act(() => focus('vision-cup'));
    expect(hook.result.current.activeThoughtId).toBe(null);
  });
  it('keeps work notes when camera clears, then removes only work when its journal clears', async () => {
    const hook = setup();
    act(() => {
      hook.result.current.updateVisualContext('Cup in view', ['vision-cup']);
      hook.result.current.updateWorkContext('work-garden: Plant tomatoes', ['work-garden']);
    });
    await connect(hook);
    expect(items()).toHaveLength(1);
    expect(items()[0].item.content[0].text).toContain('Cup in view');
    expect(items()[0].item.content[0].text).toContain('Plant tomatoes');
    act(() => hook.result.current.updateVisualContext('', []));
    expect(items()).toHaveLength(3);
    expect(items()[2].item.content[0].text).toContain('Plant tomatoes');
    expect(items()[2].item.content[0].text).not.toContain('Cup in view');
    act(() => hook.result.current.updateVisualContext('New cup', ['vision-new']));
    act(() => vi.advanceTimersByTime(3000));
    act(() => hook.result.current.updateWorkContext('', []));
    const latest = items().at(-1).item.content[0].text;
    expect(latest).toContain('New cup');
    expect(latest).not.toContain('Plant tomatoes');
    expect(items().some((event) => event.type === 'response.create')).toBe(false);
  });
  it('accepts current work focus, preserves it across camera clear, and revokes removed work IDs', async () => {
    const hook = setup();
    await connect(hook);
    act(() =>
      hook.result.current.updateWorkContext('Garden notes', ['work-garden', 'vision-not-work']),
    );
    const focus = (thought_id: string) =>
      transport.options!.onEvent({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'focus_thought',
              arguments: JSON.stringify({ thought_id }),
              call_id: crypto.randomUUID(),
            },
          ],
        },
      });
    act(() => focus('vision-not-work'));
    expect(hook.result.current.activeThoughtId).toBe(null);
    act(() => focus('work-garden'));
    expect(hook.result.current.activeThoughtId).toBe('work-garden');
    act(() => hook.result.current.updateVisualContext('', []));
    expect(hook.result.current.activeThoughtId).toBe('work-garden');
    act(() => hook.result.current.updateWorkContext('', []));
    expect(hook.result.current.activeThoughtId).toBe(null);
    act(() => focus('work-garden'));
    expect(hook.result.current.activeThoughtId).toBe(null);
  });
  it('bounds work notes and clears them on twin switch', async () => {
    const hook = renderHook(({ twin }) => useBrain(twin, updateStable, settings, chatStable), {
      initialProps: { twin: createTwin('First') },
    });
    act(() => hook.result.current.updateWorkContext('x'.repeat(9000), ['work-one']));
    await connect(hook);
    expect(items()[0].item.content[0].text.length).toBeLessThan(6300);
    hook.rerender({ twin: createTwin('Second') });
    transport.sendEvent.mockClear();
    await connect(hook);
    expect(items()).toEqual([]);
  });
});

describe('plugin tool lifecycle', () => {
  const twin = createTwin('Pip'),
    other = createTwin('Other');
  const update = vi.fn(),
    chat = vi.fn();
  const tool = {
    type: 'function',
    name: 'browser_action',
    parameters: { type: 'object', properties: {} },
  };
  const call = (id = 'call', name = 'browser_action') => ({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [{ type: 'function_call', name, call_id: id, arguments: '{}' }],
    },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  async function connect(hook: { result: { current: ReturnType<typeof useBrain> } }) {
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.toggleVoice();
    });
    await act(async () => {
      transport.resolve?.();
      await pending;
    });
  }
  it('runs a registered call once and ignores duplicate completion events', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const hook = renderHook(() => useBrain(twin, update, settings, chat, { tools: [tool], run }));
    await connect(hook);
    transport.sendEvent.mockClear();
    await act(async () => {
      transport.options!.onEvent(call());
      await Promise.resolve();
    });
    await act(async () => {
      transport.options!.onEvent(call());
    });
    expect(run).toHaveBeenCalledOnce();
    expect(
      transport.sendEvent.mock.calls.filter(([e]) => e.type === 'response.create'),
    ).toHaveLength(1);
  });
  it.each(['stop', 'switch', 'timeout', 'voice-interruption', 'disable'] as const)(
    'discards a late plugin completion after %s',
    async (kind) => {
      let resolve!: (v: unknown) => void;
      let signal!: AbortSignal;
      const run = vi.fn((_name, _args, s: AbortSignal) => {
        signal = s;
        return new Promise((r) => {
          resolve = r;
        });
      });
      const hook = renderHook(
        ({ selected, enabled }) =>
          useBrain(selected, update, settings, chat, { tools: enabled ? [tool] : [], run }),
        { initialProps: { selected: twin, enabled: true } },
      );
      await connect(hook);
      act(() => transport.options!.onEvent(call()));
      expect(run).toHaveBeenCalledOnce();
      if (kind === 'stop') act(() => hook.result.current.stop());
      if (kind === 'switch') hook.rerender({ selected: other, enabled: true });
      if (kind === 'disable') hook.rerender({ selected: twin, enabled: false });
      if (kind === 'timeout') act(() => vi.advanceTimersByTime(60000));
      if (kind === 'voice-interruption')
        act(() => transport.options!.onEvent({ type: 'input_audio_buffer.speech_started' }));
      expect(signal.aborted).toBe(true);
      transport.sendEvent.mockClear();
      await act(async () => resolve({ ok: true }));
      expect(transport.sendEvent).not.toHaveBeenCalled();
    },
  );
  it('registers only enabled tools, removes them on change, and never invokes unknown names', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const hook = renderHook(
      ({ enabled }) =>
        useBrain(twin, update, settings, chat, { tools: enabled ? [tool] : [], run }),
      { initialProps: { enabled: false } },
    );
    await connect(hook);
    expect(transport.sendEvent).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    expect(
      transport.sendEvent.mock.calls.at(-1)?.[0].session.tools.map((t: { name: string }) => t.name),
    ).toEqual(['focus_thought', 'browser_action']);
    await act(async () => transport.options!.onEvent(call('unknown', 'delete_everything')));
    expect(run).not.toHaveBeenCalled();
    hook.rerender({ enabled: false });
    expect(
      transport.sendEvent.mock.calls.at(-1)?.[0].session.tools.map((t: { name: string }) => t.name),
    ).toEqual(['focus_thought']);
  });
  it('caps an oversized tool batch at20 real actions and keeps error output valid JSON', async () => {
    const run = vi.fn(async () => ({ text: 'x'.repeat(25000) }));
    const hook = renderHook(() => useBrain(twin, update, settings, chat, { tools: [tool], run }));
    await connect(hook);
    transport.sendEvent.mockClear();
    await act(async () => {
      transport.options!.onEvent({
        type: 'response.done',
        response: {
          status: 'completed',
          output: Array.from({ length: 22 }, (_, i) => ({ ...call(String(i)).response.output[0] })),
        },
      });
    });
    expect(run).toHaveBeenCalledTimes(20);
    const events = transport.sendEvent.mock.calls.map(([e]) => e);
    expect(events.filter((e) => e.type === 'response.create')).toEqual([]);
    for (const e of events) expect(() => JSON.parse(e.item.output)).not.toThrow();
    expect(hook.result.current.error).toContain('20 actions');
  });
});
