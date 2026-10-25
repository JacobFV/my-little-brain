export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  x: number;
  y: number;
  createdAt: number;
  status: 'streaming' | 'complete' | 'interrupted' | 'failed';
};
export type Activity = { id: string; text: string; createdAt: number };
export type Twin = {
  id: string;
  name: string;
  personality: string;
  color: string;
  createdAt: number;
  messages: Message[];
  activity: Activity[];
};
export type Workspace = { version: 1; twins: Twin[]; activeId: string };
export type RealtimeEvent = { type: string; [key: string]: unknown };
export const DEFAULT_MODEL = 'gpt-realtime-2.1';
export const uid = () => globalThis.crypto.randomUUID();
export function thoughtPosition(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const a = (hash >>> 0) / 4294967295;
  hash = Math.imul(hash ^ 0x9e3779b9, 16777619);
  const b = (hash >>> 0) / 4294967295;
  return { x: (a * 2 - 1) * 0.85, y: (b * 2 - 1) * 0.75 };
}
export function springStep(
  state: { position: number; velocity: number },
  target: number,
  dt: number,
) {
  // Cap elapsed time after a background tab resumes, then integrate at <=120Hz.
  const duration = Math.min(Math.max(dt, 0), 0.1),
    steps = Math.max(1, Math.ceil(duration * 120)),
    h = duration / steps;
  let { position, velocity } = state;
  for (let i = 0; i < steps; i++) {
    velocity += (36 * (target - position) - 11 * velocity) * h;
    position += velocity * h;
  }
  return { position, velocity };
}
export function createTwin(
  name: string,
  personality = 'Curious, kind, a little playful. Help me untangle ideas and make everyday life lighter.',
): Twin {
  return {
    id: uid(),
    name: name.trim().slice(0, 40) || 'Little Brain',
    personality: personality.slice(0, 1200),
    color: '#e5a2b1',
    createdAt: Date.now(),
    messages: [],
    activity: [],
  };
}
export function addActivity(twin: Twin, text: string): Twin {
  return {
    ...twin,
    activity: [{ id: uid(), text, createdAt: Date.now() }, ...twin.activity].slice(0, 200),
  };
}
export function newMessage(
  text: string,
  role: Message['role'] = 'user',
  id: string = uid(),
): Message {
  return { id, role, text, ...thoughtPosition(id), createdAt: Date.now(), status: 'complete' };
}
export function applyRealtimeEvent(twin: Twin, event: RealtimeEvent): Twin {
  const type = event.type;
  const item = event.item as
    { id?: unknown; role?: unknown; content?: Array<{ type?: string }> } | undefined;
  const committed = type === 'input_audio_buffer.committed';
  const audioItem =
    type === 'conversation.item.added' &&
    item?.role === 'user' &&
    item?.content?.some((part) => part.type === 'input_audio');
  if (committed || audioItem) {
    const id = committed ? event.item_id : item?.id;
    if (typeof id !== 'string' || twin.messages.some((m) => m.id === id)) return twin;
    const message = { ...newMessage('', 'user', id), status: 'streaming' as const };
    const previous =
      typeof event.previous_item_id === 'string'
        ? twin.messages.findIndex((m) => m.id === event.previous_item_id)
        : -1;
    const messages = [...twin.messages];
    messages.splice(previous >= 0 ? previous + 1 : messages.length, 0, message);
    return { ...twin, messages };
  }
  const delta =
    type === 'response.output_text.delta' || type === 'response.output_audio_transcript.delta';
  const done =
    type === 'response.output_text.done' || type === 'response.output_audio_transcript.done';
  const input = type === 'conversation.item.input_audio_transcription.completed';
  if (!delta && !done && !input) return twin;
  const id = typeof event.item_id === 'string' ? event.item_id : null;
  if (!id) return twin;
  const text =
    input || type.includes('audio_transcript.done')
      ? event.transcript
      : done
        ? event.text
        : event.delta;
  if (typeof text !== 'string') return twin;
  const existing = twin.messages.find((m) => m.id === id);
  const message: Message = {
    ...(existing || newMessage('', input ? 'user' : 'assistant', id)),
    text: delta ? (existing?.text || '') + text : text,
    status: delta ? 'streaming' : 'complete',
  };
  return {
    ...twin,
    messages: existing
      ? twin.messages.map((m) => (m.id === id ? message : m))
      : [...twin.messages, message],
  };
}
export function finishStreams(
  twin: Twin,
  status: 'complete' | 'interrupted' | 'failed' = 'interrupted',
): Twin {
  return {
    ...twin,
    messages: twin.messages.map((m) => (m.status === 'streaming' ? { ...m, status } : m)),
  };
}
export function restoreWorkspace(raw: string | null): Workspace | null {
  if (!raw || raw.length > 12_000_000) return null;
  try {
    const data = JSON.parse(raw);
    if (
      data.version !== 1 ||
      !Array.isArray(data.twins) ||
      !data.twins.length ||
      data.twins.length > 50
    )
      return null;
    const ids = new Set<string>();
    for (const t of data.twins) {
      if (
        !t ||
        typeof t.id !== 'string' ||
        ids.has(t.id) ||
        typeof t.name !== 'string' ||
        !t.name.trim() ||
        t.name.length > 40 ||
        typeof t.personality !== 'string' ||
        t.personality.length > 1200 ||
        typeof t.color !== 'string' ||
        !/^#[a-f\d]{6}$/i.test(t.color) ||
        !Number.isFinite(t.createdAt) ||
        !Array.isArray(t.messages) ||
        !Array.isArray(t.activity)
      )
        return null;
      ids.add(t.id);
      const messageIds = new Set<string>();
      for (const m of t.messages) {
        if (
          !m ||
          typeof m.id !== 'string' ||
          messageIds.has(m.id) ||
          !['user', 'assistant'].includes(m.role) ||
          typeof m.text !== 'string' ||
          !Number.isFinite(m.x) ||
          Math.abs(m.x) > 1 ||
          !Number.isFinite(m.y) ||
          Math.abs(m.y) > 1 ||
          !Number.isFinite(m.createdAt) ||
          !['streaming', 'complete', 'interrupted', 'failed'].includes(m.status)
        )
          return null;
        messageIds.add(m.id);
      }
      if (
        t.activity.some(
          (a: Activity) =>
            !a ||
            typeof a.id !== 'string' ||
            typeof a.text !== 'string' ||
            !Number.isFinite(a.createdAt),
        )
      )
        return null;
    }
    return {
      version: 1,
      twins: data.twins.map((t: Twin) => finishStreams(t)),
      activeId: ids.has(data.activeId) ? data.activeId : data.twins[0].id,
    };
  } catch {
    return null;
  }
}
