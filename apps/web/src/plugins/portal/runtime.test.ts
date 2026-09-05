import { afterEach, expect, it, vi } from 'vitest';
import { createTwin, type Twin } from '@little-brain/core';
import type { BrainProvider, ProviderOptions } from '../../provider';
import { PortalRuntime, type PortalOptions } from './runtime';

afterEach(() => vi.useRealTimers());
function fixture() {
  const twins = [createTwin('A'), createTwin('B'), createTwin('C')];
  const identities: string[] = [],
    prompts: string[] = [],
    images: string[] = [];
  const disconnect = vi.fn();
  const factory = (): BrainProvider => {
    let options: ProviderOptions;
    return {
      connect: async (value) => {
        options = value;
        identities.push(value.twin.id);
      },
      sendMessage: () => {},
      sendEvent: (event) => {
        const value = event as {
          type: string;
          item?: { content: Array<{ text: string; image_url?: string }> };
        };
        if (value.item) {
          prompts.push(value.item.content[0].text);
          for (const part of value.item.content) if (part.image_url) images.push(part.image_url);
        }
        if (value.type === 'response.create') {
          options.onEvent({
            type: 'response.output_text.delta',
            item_id: 'answer',
            delta: `Reply ${identities.length}`,
          });
          options.onEvent({ type: 'response.done', response: { status: 'completed' } });
        }
      },
      disconnect,
      cancel: () => {},
    };
  };
  const options: PortalOptions = {
    twins,
    settings: { endpoint: '', token: '' },
    updateTwin: (id, update) => {
      const index = twins.findIndex((twin) => twin.id === id);
      twins[index] = update(twins[index]);
    },
    environments: { [twins[0].id]: 'A pink brain with a browser showing a garden plan.' },
  };
  const runtime = new PortalRuntime(options, () => {}, factory);
  return { runtime, options, twins, identities, prompts, images, disconnect };
}

it('exchanges more than a fixed turn budget with real provider events and local messages for both brains', async () => {
  vi.useFakeTimers();
  const { runtime, twins, identities, prompts } = fixture();
  const id = runtime.open(twins[0].id, twins[1].id);
  await vi.advanceTimersByTimeAsync(30001);
  expect(identities).toHaveLength(11);
  expect(identities.slice(0, 4)).toEqual([twins[1].id, twins[0].id, twins[1].id, twins[0].id]);
  expect(prompts[0]).toContain('a browser showing a garden plan');
  expect(prompts[1]).toContain('B: Reply 1');
  expect(twins[0].messages).toHaveLength(11);
  expect(twins[1].messages).toHaveLength(11);
  expect(twins[0].messages[0].role).toBe('user');
  expect(twins[1].messages[0].role).toBe('assistant');
  runtime.close(id);
  await vi.advanceTimersByTimeAsync(9000);
  expect(identities).toHaveLength(11);
  expect(runtime.sessions[0].status).toBe('closed');
});

it('routes queued portal messages to the recipient and resolves with that brain’s real reply', async () => {
  vi.useFakeTimers();
  const { runtime, twins, prompts } = fixture();
  const id = runtime.open(twins[0].id, twins[1].id);
  await vi.advanceTimersByTimeAsync(1);
  const response = runtime.send(id, twins[0].id, 'Please inspect this idea.');
  await vi.advanceTimersByTimeAsync(3000);
  expect(await response).toBe('Reply 2');
  expect(prompts[1]).toContain('A: Please inspect this idea.');
  expect(runtime.sessions[0].messages.at(-1)?.twinId).toBe(twins[1].id);
  runtime.dispose();
});

it('sends the current peer image as a realtime image part without persisting it locally', async () => {
  vi.useFakeTimers();
  const { runtime, options, twins, images, prompts } = fixture();
  const getEnvironmentImage = vi.fn((id: string) => `data:image/jpeg;base64,${id}`);
  runtime.sync({ ...options, getEnvironmentImage });
  const id = runtime.open(twins[0].id, twins[1].id);
  await vi.advanceTimersByTimeAsync(3001);
  expect(getEnvironmentImage.mock.calls).toEqual([[twins[0].id], [twins[1].id]]);
  expect(images).toEqual([
    `data:image/jpeg;base64,${twins[0].id}`,
    `data:image/jpeg;base64,${twins[1].id}`,
  ]);
  expect(prompts[0]).toContain('The attached image is a current view');
  expect(JSON.stringify(twins)).not.toContain('data:image');
  expect(JSON.stringify(runtime.sessions)).not.toContain('data:image');
  runtime.close(id);
  await vi.advanceTimersByTimeAsync(5000);
  expect(getEnvironmentImage).toHaveBeenCalledTimes(2);
});

it('waits while the receiving brain has foreground work and stops when a participant is deleted', async () => {
  vi.useFakeTimers();
  const { runtime, options, twins, identities } = fixture();
  runtime.sync({ ...options, foregroundTwinId: twins[1].id });
  runtime.open(twins[0].id, twins[1].id);
  await vi.advanceTimersByTimeAsync(4000);
  expect(identities).toEqual([]);
  runtime.sync(options);
  await vi.advanceTimersByTimeAsync(300);
  expect(identities).toHaveLength(1);
  runtime.sync({ ...options, twins: [twins[0]] });
  await vi.advanceTimersByTimeAsync(5000);
  expect(identities).toHaveLength(1);
  expect(runtime.sessions[0].status).toBe('closed');
  runtime.dispose();
});

it('closes the previous pair before opening another and rejects invalid senders', async () => {
  vi.useFakeTimers();
  const { runtime, twins } = fixture();
  runtime.open(twins[0].id, twins[1].id);
  const id = runtime.open(twins[1].id, twins[2].id);
  expect(runtime.sessions.map((session) => session.status)).toEqual(['closed', 'open']);
  await expect(runtime.send(id, twins[0].id, 'hello')).rejects.toThrow('not connected');
  runtime.dispose();
});

it('surfaces provider errors without creating artificial peer replies', async () => {
  const twins = [createTwin('A'), createTwin('B')];
  const runtime = new PortalRuntime(
    { twins, settings: { endpoint: '', token: '' }, updateTwin: vi.fn() },
    () => {},
    () => ({
      connect: async () => {
        throw new Error('Quota reached');
      },
      sendEvent: () => {},
      sendMessage: () => {},
      cancel: () => {},
      disconnect: () => {},
    }),
  );
  runtime.open(twins[0].id, twins[1].id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runtime.sessions[0].status).toBe('error');
  expect(runtime.sessions[0].error).toBe('Quota reached');
  expect(runtime.sessions[0].messages).toEqual([]);
  runtime.dispose();
});

it('cancels a connecting provider immediately and ignores its late completion', async () => {
  let resolve!: () => void;
  const disconnect = vi.fn(),
    send = vi.fn();
  const twins: Twin[] = [createTwin('A'), createTwin('B')];
  const runtime = new PortalRuntime(
    { twins, settings: { endpoint: '', token: '' }, updateTwin: vi.fn() },
    () => {},
    () => ({
      connect: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      sendEvent: send,
      sendMessage: () => {},
      cancel: () => {},
      disconnect,
    }),
  );
  const id = runtime.open(twins[0].id, twins[1].id);
  runtime.close(id);
  expect(disconnect).toHaveBeenCalledOnce();
  resolve();
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  runtime.dispose();
});

it('rejects queued sends when closing a paused portal and does not restart on settings changes', async () => {
  vi.useFakeTimers();
  const { runtime, options, twins, identities } = fixture();
  runtime.sync({ ...options, foregroundTwinId: twins[1].id });
  const id = runtime.open(twins[0].id, twins[1].id);
  const response = runtime.send(id, twins[0].id, 'Are you there?');
  const rejected = expect(response).rejects.toThrow('Portal closed');
  runtime.sync({ ...options, settings: { endpoint: 'https://new.example', token: '' } });
  await rejected;
  await vi.advanceTimersByTimeAsync(6000);
  expect(identities).toEqual([]);
  expect(runtime.sessions[0].status).toBe('closed');
  runtime.dispose();
});

it('aborts a peer draft when foreground work starts and retries when it ends', async () => {
  vi.useFakeTimers();
  const twins = [createTwin('A'), createTwin('B')];
  const disconnect = vi.fn();
  const connect = vi.fn(async () => {});
  const options: PortalOptions = {
    twins,
    settings: { endpoint: '', token: '' },
    updateTwin: vi.fn(),
  };
  const runtime = new PortalRuntime(
    options,
    () => {},
    () => ({
      connect,
      sendEvent: () => {},
      sendMessage: () => {},
      cancel: () => {},
      disconnect,
    }),
  );
  runtime.open(twins[0].id, twins[1].id);
  await vi.advanceTimersByTimeAsync(1);
  expect(runtime.sessions[0].draft?.twinId).toBe(twins[1].id);
  runtime.sync({ ...options, foregroundTwinId: twins[1].id });
  await vi.advanceTimersByTimeAsync(1000);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledOnce();
  expect(runtime.sessions[0].draft).toBeUndefined();
  runtime.sync(options);
  await vi.advanceTimersByTimeAsync(300);
  expect(connect).toHaveBeenCalledTimes(2);
  runtime.dispose();
});
