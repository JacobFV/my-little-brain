import { expect, it } from 'vitest';
import { createInteraction, mergeInteraction } from './interactions';
it('gives simultaneous uses distinct stable locations and keeps terminal instances terminal', () => {
  const first = createInteraction('a', 'files', 'File', 'icon', 'one'),
    second = createInteraction('a', 'files', 'File', 'icon', 'two');
  expect(first.id).not.toBe(second.id);
  expect(createInteraction('a', 'files', 'File', 'icon', 'one').x).toBe(first.x);
  const ended = { ...first, status: 'complete' as const };
  expect(mergeInteraction([ended], first)).toEqual([ended]);
  expect(mergeInteraction([first], second)).toHaveLength(2);
});
