import { describe, it, expect } from 'vitest';
import { createTwin } from '@little-brain/core';
import { createJob, restoreJobs, turnPrompt } from './jobs';
describe('background jobs', () => {
  it('validates participants without imposing a turn limit', () => {
    const a = createTwin('A'),
      b = createTwin('B'),
      c = createTwin('C');
    expect(createJob('Plan a garden', [a, b])).not.toHaveProperty('maxTurns');
    expect(() => createJob('topic', [a, b, c])).toThrow();
    expect(() => createJob(' ', [a])).toThrow();
  });
  it('restores active jobs interrupted without restarting them', () => {
    const job = createJob('Garden', [createTwin('A')]);
    job.status = 'running';
    expect(restoreJobs(JSON.stringify([job]))[0].status).toBe('interrupted');
    expect(restoreJobs('[{"status":"running"}]')).toEqual([]);
  });
  it('preserves collaboration order and attributes both speakers in context', () => {
    const a = createTwin('A'),
      b = createTwin('B');
    const job = createJob('Garden', [a, b]);
    job.transcript = [
      { id: '1', twinId: a.id, name: 'A', text: 'Start with soil.', createdAt: 1 },
      { id: '2', twinId: b.id, name: 'B', text: 'Then choose seeds.', createdAt: 2 },
    ];
    const prompt = turnPrompt(job);
    expect(prompt.indexOf('A: Start with soil.')).toBeLessThan(
      prompt.indexOf('B: Then choose seeds.'),
    );
    expect(prompt).toContain('Garden');
  });
  it('bounds request context while retaining the entire journal', () => {
    const a = createTwin('A');
    const job = createJob('Garden', [a]);
    job.transcript = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      twinId: a.id,
      name: 'A',
      text: `Contribution ${i}: ` + 'x'.repeat(4000),
      createdAt: i,
    }));
    const prompt = turnPrompt(job);
    expect(prompt.length).toBeLessThan(27000);
    expect(prompt).toContain('Contribution 29:');
    expect(prompt).not.toContain('Contribution 0:');
    expect(job.transcript).toHaveLength(30);
  });
});
