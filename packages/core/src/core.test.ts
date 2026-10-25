import { describe, expect, it } from 'vitest';
import {
  thoughtPosition,
  springStep,
  applyRealtimeEvent,
  createTwin,
  restoreWorkspace,
} from './index';

describe('thoughts on the glass', () => {
  it('places the same item consistently inside a usable plane', () => {
    for (let i = 0; i < 100; i++) {
      const p = thoughtPosition(`item-${i}`);
      expect(p).toEqual(thoughtPosition(`item-${i}`));
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.85);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(0.75);
    }
    expect(thoughtPosition('first')).not.toEqual(thoughtPosition('second'));
  });
  it('pulls gaze to a thought without exploding after a suspended frame', () => {
    let s = { position: 0, velocity: 0 };
    for (let i = 0; i < 240; i++) s = springStep(s, 1, 1 / 60);
    expect(s.position).toBeCloseTo(1, 3);
    expect(Math.abs(springStep(s, -1, 60).position)).toBeLessThan(2);
  });
});
describe('conversation events', () => {
  it('streams text into one thought and finalizes it', () => {
    let twin = createTwin('Pip');
    twin = applyRealtimeEvent(twin, {
      type: 'response.output_text.delta',
      item_id: 'a',
      delta: 'Hello',
    });
    twin = applyRealtimeEvent(twin, {
      type: 'response.output_text.delta',
      item_id: 'a',
      delta: ' there',
    });
    expect(twin.messages).toHaveLength(1);
    expect(twin.messages[0].text).toBe('Hello there');
    twin = applyRealtimeEvent(twin, {
      type: 'response.output_text.done',
      item_id: 'a',
      text: 'Hello there',
    });
    expect(twin.messages[0].status).toBe('complete');
    expect(twin.messages[0].x).toBeDefined();
  });
  it('deduplicates transcription and isolates unrelated events', () => {
    let twin = createTwin('Pip');
    const ev = {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u',
      transcript: 'A thought',
    };
    twin = applyRealtimeEvent(applyRealtimeEvent(twin, ev), ev);
    expect(twin.messages).toHaveLength(1);
    expect(applyRealtimeEvent(twin, { type: 'unknown' })).toEqual(twin);
  });
  it('keeps voice user turns before replies even when transcription arrives late', () => {
    let twin = createTwin('Pip');
    twin = applyRealtimeEvent(twin, {
      type: 'input_audio_buffer.committed',
      item_id: 'voice-user',
    });
    twin = applyRealtimeEvent(twin, {
      type: 'response.output_text.delta',
      item_id: 'reply',
      delta: 'An answer',
    });
    twin = applyRealtimeEvent(twin, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'voice-user',
      transcript: 'A question',
    });
    expect(twin.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(twin.messages[0].text).toBe('A question');
  });
  it('rejects invalid persisted state and repairs interrupted streams', () => {
    expect(restoreWorkspace('{broken')).toBeNull();
    expect(restoreWorkspace('{"twins":[{}]}')).toBeNull();
    const twin = createTwin('Pip');
    twin.messages.push({
      id: 'a',
      role: 'assistant',
      text: 'partial',
      x: 0,
      y: 0,
      createdAt: 1,
      status: 'streaming',
    });
    const saved = restoreWorkspace(
      JSON.stringify({ version: 1, twins: [twin], activeId: twin.id }),
    );
    expect(saved?.twins[0].messages[0].status).toBe('interrupted');
  });
});
