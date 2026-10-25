import { thoughtPosition, type Twin } from '@little-brain/core';
import { portalResponse, type PortalConnection, type ProviderFactory } from './response';

export type PortalMessage = {
  id: string;
  twinId: string;
  name: string;
  text: string;
  createdAt: number;
};
export type PortalSession = {
  id: string;
  sourceTwinId: string;
  targetTwinId: string;
  status: 'open' | 'closed' | 'error';
  createdAt: number;
  messages: PortalMessage[];
  draft?: PortalMessage;
  error?: string;
};
export type PortalOptions = {
  twins: Twin[];
  settings: PortalConnection;
  updateTwin: (id: string, update: (twin: Twin) => Twin) => void;
  foregroundTwinId?: string | null;
  ready?: boolean;
  environment?: (id: string) => string;
  environments?: Record<string, string>;
  /** Ephemeral peer image sent to the provider only during an open portal turn. */
  getEnvironmentImage?: (id: string) => string | undefined;
};
type WaitingMessage = {
  from: string;
  text: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};
type Live = {
  abort: AbortController;
  queue: WaitingMessage[];
  next: string;
  turn?: AbortController;
};

function delay(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Session history stays in each brain's local messages; opening a page never starts API work. */
export class PortalRuntime {
  sessions: PortalSession[] = [];
  private live = new Map<string, Live>();
  private disposed = false;
  constructor(
    public options: PortalOptions,
    private publish: (sessions: PortalSession[]) => void,
    private factory?: ProviderFactory,
  ) {}

  sync(options: PortalOptions) {
    const changed =
      options.settings.endpoint !== this.options.settings.endpoint ||
      options.settings.token !== this.options.settings.token;
    this.options = options;
    for (const session of this.sessions) {
      if (session.status !== 'open') continue;
      if (
        changed ||
        !options.twins.some((twin) => twin.id === session.sourceTwinId) ||
        !options.twins.some((twin) => twin.id === session.targetTwinId)
      )
        this.close(session.id);
      else if (session.draft?.twinId === options.foregroundTwinId)
        this.live.get(session.id)?.turn?.abort();
    }
  }
  private update(id: string, update: (session: PortalSession) => PortalSession) {
    if (this.disposed) return;
    this.sessions = this.sessions.map((session) => (session.id === id ? update(session) : session));
    this.publish(this.sessions);
  }
  private twin(id: string) {
    const twin = this.options.twins.find((item) => item.id === id);
    if (!twin) throw new Error('This brain is no longer available.');
    return twin;
  }
  open = (sourceTwinId: string, targetTwinId: string, topic = '') => {
    if (this.disposed || this.options.ready === false)
      throw new Error('Your brains are still loading.');
    if (sourceTwinId === targetTwinId) throw new Error('Choose another brain for the portal.');
    this.twin(sourceTwinId);
    this.twin(targetTwinId);
    const existing = this.sessions.find(
      (session) =>
        session.status === 'open' &&
        [session.sourceTwinId, session.targetTwinId].includes(sourceTwinId) &&
        [session.sourceTwinId, session.targetTwinId].includes(targetTwinId),
    );
    if (existing) return existing.id;
    // One reciprocal pair at a time bounds both provider concurrency and scene rendering.
    for (const session of this.sessions) if (session.status === 'open') this.close(session.id);
    const session: PortalSession = {
      id: crypto.randomUUID(),
      sourceTwinId,
      targetTwinId,
      status: 'open',
      createdAt: Date.now(),
      messages: [],
    };
    const live: Live = { abort: new AbortController(), queue: [], next: targetTwinId };
    this.live.set(session.id, live);
    this.sessions = [...this.sessions, session];
    this.publish(this.sessions);
    if (topic.trim()) this.append(session.id, sourceTwinId, topic.trim().slice(0, 12000));
    void this.run(session.id, live);
    return session.id;
  };
  close = (id: string) => {
    const live = this.live.get(id);
    live?.abort.abort();
    live?.turn?.abort();
    live?.queue.splice(0).forEach((item) => item.reject(new Error('Portal closed.')));
    this.live.delete(id);
    this.update(id, (session) => ({ ...session, status: 'closed', draft: undefined }));
  };
  send = (id: string, fromTwinId: string, text: string): Promise<string> => {
    const session = this.sessions.find((item) => item.id === id);
    const live = this.live.get(id);
    if (!session || session.status !== 'open' || !live)
      return Promise.reject(new Error('Open a portal first.'));
    if (![session.sourceTwinId, session.targetTwinId].includes(fromTwinId))
      return Promise.reject(new Error('This brain is not connected to that portal.'));
    if (!text.trim()) return Promise.reject(new Error('Enter a portal message.'));
    return new Promise((resolve, reject) =>
      live.queue.push({ from: fromTwinId, text: text.trim().slice(0, 12000), resolve, reject }),
    );
  };
  private append(
    id: string,
    twinId: string,
    text: string,
    messageId: string = crypto.randomUUID(),
  ) {
    const session = this.sessions.find((item) => item.id === id)!;
    const speaker = this.twin(twinId);
    const message: PortalMessage = {
      id: messageId,
      twinId,
      name: speaker.name,
      text,
      createdAt: Date.now(),
    };
    this.update(id, (current) => ({
      ...current,
      messages: [...current.messages, message],
      draft: undefined,
    }));
    for (const recipient of [session.sourceTwinId, session.targetTwinId]) {
      this.options.updateTwin(recipient, (twin) => ({
        ...twin,
        messages: [
          ...twin.messages,
          {
            id: message.id,
            role: recipient === twinId ? 'assistant' : 'user',
            text: `[Portal · ${speaker.name}] ${text}`,
            status: 'complete',
            createdAt: message.createdAt,
            ...thoughtPosition(message.id),
          },
        ],
      }));
    }
  }
  private async run(id: string, live: Live) {
    let pending: WaitingMessage | undefined;
    try {
      while (!live.abort.signal.aborted) {
        let session = this.sessions.find((item) => item.id === id)!;
        if (!pending && live.queue.length) {
          pending = live.queue.shift()!;
          this.append(id, pending.from, pending.text);
          live.next =
            pending.from === session.sourceTwinId ? session.targetTwinId : session.sourceTwinId;
        }
        if (this.options.foregroundTwinId === live.next) {
          await delay(live.abort.signal, 250);
          continue;
        }
        session = this.sessions.find((item) => item.id === id)!;
        const twin = this.twin(live.next);
        const peer = this.twin(
          twin.id === session.sourceTwinId ? session.targetTwinId : session.sourceTwinId,
        );
        const draft: PortalMessage = {
          id: crypto.randomUUID(),
          twinId: twin.id,
          name: twin.name,
          text: '',
          createdAt: Date.now(),
        };
        const turn = new AbortController();
        live.turn = turn;
        const abort = () => turn.abort();
        live.abort.signal.addEventListener('abort', abort, { once: true });
        this.update(id, (value) => ({ ...value, draft }));
        const environment =
          this.options.environments?.[peer.id] ??
          this.options.environment?.(peer.id) ??
          `Recent visible thoughts: ${peer.messages
            .slice(-6)
            .map((message) => message.text.slice(0, 400))
            .join('\n')}`;
        const image = this.options.getEnvironmentImage?.(peer.id);
        const imageUrl =
          image?.startsWith('data:image/jpeg;base64,') && image.length <= 1000000
            ? image
            : undefined;
        const prompt = `A reciprocal portal connects your environment with ${peer.name}'s environment. You are ${twin.name}; speak directly as yourself to ${peer.name}. ${imageUrl ? "The attached image is a current view of your peer's rendered brain environment. You can see their brain, visible thought bubbles, and plugin surfaces. Reciprocal portal surfaces are omitted to bound recursion." : 'No current image is available; use only the following description of the peer environment.'} Describe only the environment details provided here or visible in the image, never invent visual observations.\nPeer environment:\n${environment.slice(0, 5000)}\n\nRecent portal conversation:\n${
          session.messages
            .slice(-20)
            .map((message) => `${message.name}: ${message.text}`)
            .join('\n')
            .slice(-24000) ||
          '(The portal just opened. Greet your peer and start a thoughtful conversation.)'
        }\n\nReply briefly with a useful thought, question, or next step. This is an ongoing conversation, not a task with a fixed number of turns. Do not speak for the other brain.`;
        let text: string;
        try {
          text = await portalResponse(
            twin,
            prompt,
            this.options.settings,
            turn.signal,
            (text) => this.update(id, (value) => ({ ...value, draft: { ...draft, text } })),
            this.factory,
            imageUrl,
          );
        } catch (error) {
          if (turn.signal.aborted && !live.abort.signal.aborted) {
            this.update(id, (value) => ({ ...value, draft: undefined }));
            await delay(live.abort.signal, 250);
            continue;
          }
          throw error;
        } finally {
          live.abort.signal.removeEventListener('abort', abort);
          live.turn = undefined;
        }
        if (live.abort.signal.aborted) break;
        this.append(id, twin.id, text, draft.id);
        pending?.resolve(text);
        pending = undefined;
        live.next = peer.id;
        await delay(live.abort.signal, 3000);
      }
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error('The portal connection failed.');
      if (!live.abort.signal.aborted)
        this.update(id, (session) => ({
          ...session,
          status: 'error',
          error: error.message,
          draft: undefined,
        }));
      pending?.reject(error);
      pending = undefined;
      live.queue.splice(0).forEach((item) => item.reject(error));
    } finally {
      pending?.reject(new Error('Portal closed.'));
      if (this.live.get(id) === live) this.live.delete(id);
    }
  }
  dispose() {
    for (const id of this.live.keys()) this.close(id);
    this.disposed = true;
  }
}
