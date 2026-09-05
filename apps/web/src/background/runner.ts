import { type Twin, type RealtimeEvent } from '@little-brain/core';
import { OpenAIRealtimeProvider, type BrainProvider } from '../provider';
import { turnPrompt, type BackgroundJob, type JobTurn } from './jobs';
type Connection = { endpoint: string; token: string };
function responseTurn(
  job: BackgroundJob,
  connection: Connection,
  signal: AbortSignal,
  onDraft: (text: string) => void,
  factory: () => BrainProvider,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Stopped.'));
      return;
    }
    const provider = factory();
    let settled = false;
    const parts = new Map<string, string>();
    const timer = setTimeout(
      () => finish(new Error('This background turn timed out. Resume to try again.')),
      60000,
    );
    const abort = () => finish(new Error('Stopped.'));
    const finish = (failure?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      provider.disconnect();
      if (failure) reject(failure);
      else resolve(text ?? '');
    };
    signal.addEventListener('abort', abort, { once: true });
    const onEvent = (event: RealtimeEvent) => {
      if (settled || signal.aborted) return;
      if (
        (event.type === 'response.output_text.delta' ||
          event.type === 'response.output_text.done') &&
        typeof event.item_id === 'string'
      ) {
        const text = event.type.endsWith('.delta') ? event.delta : event.text;
        if (typeof text === 'string') {
          parts.set(
            event.item_id,
            (event.type.endsWith('.delta') ? (parts.get(event.item_id) ?? '') + text : text).slice(
              0,
              12000,
            ),
          );
          onDraft([...parts.values()].join('\n').slice(0, 12000));
        }
      }
      if (event.type === 'response.done') {
        const response = event.response as
          | {
              status?: string;
              output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
            }
          | undefined;
        if (response?.status !== 'completed') {
          finish(new Error('The background reply was interrupted or failed. Resume to try again.'));
          return;
        }
        const text = (
          [...parts.values()].join('\n') ||
          response.output
            ?.flatMap((item) => item.content?.map((c) => c.text ?? '') ?? [])
            .join('\n') ||
          ''
        )
          .trim()
          .slice(0, 12000);
        if (!text) {
          finish(new Error('The provider returned no text. Resume to try again.'));
          return;
        }
        finish(undefined, text);
      }
    };
    const participant = job.participants[job.transcript.length % job.participants.length];
    const twin: Twin = { ...participant, createdAt: job.createdAt, messages: [], activity: [] };
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
            content: [{ type: 'input_text', text: turnPrompt(job) }],
          },
        });
        provider.sendEvent({
          type: 'response.create',
          response: { tool_choice: 'none', max_output_tokens: 700 },
        });
      })
      .catch((error) =>
        finish(
          error instanceof Error ? error : new Error('Could not connect to the brain server.'),
        ),
      );
  });
}
export async function runJob(
  initial: BackgroundJob,
  connection: Connection,
  signal: AbortSignal,
  onUpdate: (job: BackgroundJob) => void,
  factory: () => BrainProvider = () => new OpenAIRealtimeProvider(),
): Promise<BackgroundJob> {
  let job: BackgroundJob = {
    ...initial,
    transcript: initial.draft?.text
      ? [...initial.transcript, { ...initial.draft, unfinished: true }]
      : initial.transcript,
    status: 'running',
    error: '',
    draft: null,
  };
  const publish = () => {
    job = { ...job, updatedAt: Date.now() };
    onUpdate(job);
  };
  publish();
  try {
    while (!signal.aborted) {
      if (signal.aborted) throw new Error('Stopped.');
      const participant = job.participants[job.transcript.length % job.participants.length];
      const draft: JobTurn = {
        id: crypto.randomUUID(),
        twinId: participant.id,
        name: participant.name,
        text: '',
        createdAt: Date.now(),
      };
      job = { ...job, draft };
      publish();
      const text = await responseTurn(
        job,
        connection,
        signal,
        (text) => {
          job = { ...job, draft: { ...draft, text } };
          publish();
        },
        factory,
      );
      if (signal.aborted) throw new Error('Stopped.');
      job = { ...job, transcript: [...job.transcript, { ...draft, text }], draft: null };
      publish();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 3000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    job = { ...job, status: 'interrupted' };
  } catch (error) {
    job = {
      ...job,
      status: signal.aborted ? 'interrupted' : 'failed',
      error: signal.aborted
        ? ''
        : (error instanceof Error ? error.message : 'Background work failed.').slice(0, 1000),
    };
  }
  publish();
  return job;
}
