import { expect, it } from 'vitest';
import { createTwin } from '@little-brain/core';
import { createJob } from './background/jobs';
import { workContextFor } from './workContext';
it('excludes unrelated circles and bounds work context with stable thought IDs', () => {
  const a = createTwin('A'),
    b = createTwin('B');
  const job = createJob('Shared topic', [a]);
  job.transcript = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    twinId: a.id,
    name: a.name,
    text: 'x'.repeat(12000),
    createdAt: i,
  }));
  expect(workContextFor(b.id, [job])).toEqual({ text: '', thoughts: [] });
  const context = workContextFor(a.id, [job]);
  expect(context.thoughts).toHaveLength(6);
  expect(context.text.length).toBeLessThan(6000);
  expect(context.thoughts[0].id).toBe('work-6');
  expect(context.thoughts).toEqual(workContextFor(a.id, [job]).thoughts);
});
