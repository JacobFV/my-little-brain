import { thoughtPosition } from '@little-brain/core';
import type { BackgroundJob } from './background/jobs';
/** A brain sees only circles it participated in, with no other twins' private chat histories. */
export function workContextFor(twinId: string, jobs: BackgroundJob[]) {
  const contributions = jobs
    .filter((job) => job.participants.some((p) => p.id === twinId))
    .flatMap((job) => job.transcript.map((turn) => ({ job, turn })))
    .sort((a, b) => a.turn.createdAt - b.turn.createdAt)
    .slice(-6);
  const thoughts = contributions.map(({ turn }) => ({
    id: `work-${turn.id}`,
    text: `${turn.name}: ${turn.text}`,
    ...thoughtPosition(`work-${turn.id}`),
  }));
  const text = contributions.length
    ? `Recent locally saved background work from circles you participated in. These are written contributions, not external actions or hidden reasoning.\n${contributions.map(({ job, turn }, index) => `[thought_id: ${thoughts[index].id}] Topic: ${job.topic.slice(0, 140)}\n${turn.name}: ${turn.text.slice(0, 700)}`).join('\n\n')}`
    : '';
  return { text, thoughts };
}
