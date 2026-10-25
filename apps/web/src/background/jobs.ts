import type { Twin } from '@little-brain/core';
export type Participant = Pick<Twin, 'id' | 'name' | 'personality' | 'color'>;
export type JobTurn = {
  id: string;
  twinId: string;
  name: string;
  text: string;
  createdAt: number;
  unfinished?: boolean;
};
export type BackgroundJob = {
  id: string;
  topic: string;
  participants: Participant[];
  status: 'running' | 'complete' | 'interrupted' | 'failed';
  createdAt: number;
  updatedAt: number;
  transcript: JobTurn[];
  draft: JobTurn | null;
  error: string;
};
export function createJob(topic: string, twins: Twin[]): BackgroundJob {
  if (!topic.trim()) throw new Error('Give your brains a topic to work on.');
  if (twins.length < 1 || twins.length > 2 || new Set(twins.map((t) => t.id)).size !== twins.length)
    throw new Error('Choose one or two different brains.');
  return {
    id: crypto.randomUUID(),
    topic: topic.trim().slice(0, 2000),
    participants: twins.map(({ id, name, personality, color }) => ({
      id,
      name,
      personality,
      color,
    })),
    status: 'interrupted',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    transcript: [],
    draft: null,
    error: '',
  };
}
export function turnPrompt(job: BackgroundJob) {
  const recent: JobTurn[] = [];
  let remaining = 24000;
  for (const t of [...job.transcript].reverse()) {
    if (recent.length >= 8 || t.text.length > remaining) break;
    recent.unshift(t);
    remaining -= t.text.length;
  }
  const next = job.participants[job.transcript.length % job.participants.length];
  return `This is an explicitly requested background work session. Topic: ${job.topic}\nParticipants: ${job.participants.map((p) => p.name).join(', ')}. You are ${next.name}, contributing turn ${job.transcript.length + 1} in an ongoing session.\n${job.transcript.length ? `Previous contributions, in order:\n${recent.map((t) => `${t.name}${t.unfinished ? ' (unfinished)' : ''}: ${t.text}`).join('\n\n')}` : 'There are no previous contributions.'}\nContribute a useful next step in under 160 words. Build on earlier contributions without repeating them. Offer a concrete idea, check a tradeoff, improve the plan, or periodically synthesize useful next steps. You can only reason and write here; you have not browsed, contacted anyone, or performed external actions. Do not call any tools. Reply only with your contribution.`;
}
export function restoreJobs(raw: string | null): BackgroundJob[] {
  if (!raw || raw.length > 50_000_000) return [];
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 1000) return [];
    const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
    const ids = new Set<string>();
    const turn = (t: any) =>
      t &&
      text(t.id, 100) &&
      text(t.twinId, 100) &&
      text(t.name, 40) &&
      text(t.text, 12000) &&
      Number.isFinite(t.createdAt) &&
      (t.unfinished === undefined || typeof t.unfinished === 'boolean');
    for (const j of values) {
      if (
        !j ||
        !text(j.id, 100) ||
        ids.has(j.id) ||
        !text(j.topic, 2000) ||
        !j.topic.trim() ||
        !Array.isArray(j.participants) ||
        j.participants.length < 1 ||
        j.participants.length > 2 ||
        !j.participants.every(
          (p: any) =>
            p &&
            text(p.id, 100) &&
            text(p.name, 40) &&
            text(p.personality, 1200) &&
            typeof p.color === 'string' &&
            /^#[a-f\d]{6}$/i.test(p.color),
        ) ||
        new Set(j.participants.map((p: any) => p.id)).size !== j.participants.length ||
        !['running', 'complete', 'interrupted', 'failed'].includes(j.status) ||
        !Number.isFinite(j.createdAt) ||
        !Number.isFinite(j.updatedAt) ||
        !Array.isArray(j.transcript) ||
        !j.transcript.every(turn) ||
        (j.draft !== null && !turn(j.draft)) ||
        !text(j.error, 1000)
      )
        return [];
      ids.add(j.id);
    }
    return values.map((j) => ({ ...j, status: j.status === 'running' ? 'interrupted' : j.status }));
  } catch {
    return [];
  }
}
