import type { Twin, RealtimeEvent } from '@little-brain/core';
import { OpenAIRealtimeProvider, type BrainProvider } from '../../provider';

export type PortalConnection = { endpoint: string; token: string };
export type ProviderFactory = () => BrainProvider;

/** A portal turn owns its connection, so closing it cannot cancel foreground chat. */
export function portalResponse(
  twin: Twin,
  prompt: string,
  connection: PortalConnection,
  signal: AbortSignal,
  onDraft: (text: string) => void,
  factory: ProviderFactory = () => new OpenAIRealtimeProvider(),
  imageUrl?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Portal closed.'));
    const provider = factory();
    const parts = new Map<string, string>();
    let settled = false;
    const finish = (error?: Error, text = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      provider.disconnect();
      if (error) reject(error);
      else resolve(text);
    };
    const abort = () => finish(new Error('Portal closed.'));
    const timer = setTimeout(
      () => finish(new Error('The portal reply timed out. Reopen the portal to retry.')),
      60000,
    );
    signal.addEventListener('abort', abort, { once: true });
    const onEvent = (event: RealtimeEvent) => {
      if (settled || signal.aborted) return;
      if (
        (event.type === 'response.output_text.delta' ||
          event.type === 'response.output_text.done') &&
        typeof event.item_id === 'string'
      ) {
        const value = event.type.endsWith('.delta') ? event.delta : event.text;
        if (typeof value === 'string') {
          parts.set(
            event.item_id,
            (event.type.endsWith('.delta')
              ? (parts.get(event.item_id) ?? '') + value
              : value
            ).slice(0, 12000),
          );
          onDraft([...parts.values()].join('\n').slice(0, 12000));
        }
      }
      if (event.type === 'error')
        finish(new Error('The provider could not complete the portal reply.'));
      if (event.type === 'response.done') {
        const response = event.response as
          { status?: string; output?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
        if (response?.status !== 'completed')
          return finish(new Error('The portal reply was interrupted or failed.'));
        const text = (
          [...parts.values()].join('\n') ||
          response.output
            ?.flatMap((item) => item.content?.map((part) => part.text ?? '') ?? [])
            .join('\n') ||
          ''
        )
          .trim()
          .slice(0, 12000);
        finish(text ? undefined : new Error('The provider returned no portal reply.'), text);
      }
    };
    void provider
      .connect({
        twin,
        mode: 'text',
        ...connection,
        onEvent,
        onStatus: () => {},
        onError: (message) => finish(new Error(message)),
      })
      .then(() => {
        if (settled || signal.aborted) return;
        provider.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              ...(imageUrl ? [{ type: 'input_image', image_url: imageUrl }] : []),
            ],
          },
        });
        provider.sendEvent({
          type: 'response.create',
          response: { tool_choice: 'none', max_output_tokens: 500 },
        });
      })
      .catch((error) =>
        finish(error instanceof Error ? error : new Error('Could not connect through the portal.')),
      );
  });
}
