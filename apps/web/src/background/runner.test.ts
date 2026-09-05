import { describe, it, expect, vi } from 'vitest';
import { createTwin, type Message } from '@little-brain/core';
import type { BrainProvider, ProviderOptions } from '../provider';
import { createJob } from './jobs';
import { runJob } from './runner';
const settings = { endpoint: '', token: '' };
describe('background execution', () => {
  it('runs real provider turns sequentially with previous collaboration context', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const identities: string[] = [],
      prompts: string[] = [];
    let options!: ProviderOptions;
    const factory = (): BrainProvider => ({
      connect: async (o) => {
        options = o;
        identities.push(o.twin.name);
      },
      sendMessage: (_m: Message) => {},
      sendEvent: (event) => {
        const ev = event as any;
        if (ev.type === 'conversation.item.create') prompts.push(ev.item.content[0].text);
        if (ev.type === 'response.create') {
          options.onEvent({
            type: 'response.output_text.done',
            item_id: 'answer',
            text: `Reply ${identities.length}`,
          });
          options.onEvent({ type: 'response.done', response: { status: 'completed' } });
        }
      },
      cancel: () => {},
      disconnect: () => {},
    });
    const pending = runJob(
      createJob('Garden', [createTwin('A'), createTwin('B')]),
      settings,
      controller.signal,
      (job) => {
        if (job.transcript.length === 8) controller.abort();
      },
      factory,
    );
    await vi.advanceTimersByTimeAsync(24000);
    const result = await pending;
    vi.useRealTimers();
    expect(identities).toEqual(['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
    expect(result.status).toBe('interrupted');
    expect(result.transcript).toHaveLength(8);
    expect(prompts[1]).toContain('A: Reply 1');
  });
  it('stops immediately during connection and never sends a turn afterwards', async () => {
    const controller = new AbortController();
    let disconnected = 0,
      sent = 0,
      resolve!: () => void;
    const provider: BrainProvider = {
      connect: () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
      sendMessage: () => {},
      sendEvent: () => {
        sent++;
      },
      cancel: () => {},
      disconnect: () => {
        disconnected++;
      },
    };
    const pending = runJob(
      createJob('Garden', [createTwin('A')]),
      settings,
      controller.signal,
      () => {},
      () => provider,
    );
    controller.abort();
    const result = await pending;
    resolve();
    await Promise.resolve();
    expect(result.status).toBe('interrupted');
    expect(disconnected).toBeGreaterThan(0);
    expect(sent).toBe(0);
  });
  it('surfaces provider failures without inventing a response', async () => {
    const provider: BrainProvider = {
      connect: async () => {
        throw new Error('Quota reached');
      },
      sendMessage: () => {},
      sendEvent: () => {},
      cancel: () => {},
      disconnect: () => {},
    };
    const result = await runJob(
      createJob('Garden', [createTwin('A')]),
      settings,
      new AbortController().signal,
      () => {},
      () => provider,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Quota reached');
    expect(result.transcript).toEqual([]);
  });
});

it('preserves an interrupted draft in the journal when resuming', async () => {
  const twin = createTwin('A'),
    job = createJob('Garden', [twin]);
  job.draft = { id: 'partial', name: 'A', twinId: twin.id, text: 'A partial idea', createdAt: 1 };
  const controller = new AbortController();
  let published = false;
  const result = await runJob(job, settings, controller.signal, () => {
    if (!published) {
      published = true;
      controller.abort();
    }
  });
  expect(result.transcript).toEqual([{ ...job.draft, unfinished: true }]);
  expect(result.status).toBe('interrupted');
});
