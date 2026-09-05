import { describe, expect, it } from 'vitest';
import { plugins, pluginStatus, readPocketFile, passageMessage } from './catalog';
describe('plugin capabilities', () => {
  it('distinguishes missing adapters from unsupported platforms', () => {
    expect(
      pluginStatus(
        plugins.find((p) => p.id === 'browser')!,
        'web',
      ),
    ).toBe('other-platform');
    expect(
      pluginStatus(
        plugins.find((p) => p.id === 'computer')!,
        'desktop',
      ),
    ).toBe('planned');
    expect(
      pluginStatus(
        plugins.find((p) => p.id === 'files')!,
        'ios',
      ),
    ).toBe('available');
  });
  it('bounds attachment content and rejects oversized and binary input', async () => {
    await expect(
      readPocketFile({ name: 'large', size: 300000, text: async () => '' }),
    ).rejects.toThrow('256 KB');
    await expect(
      readPocketFile({ name: 'binary', size: 5, text: async () => 'a\0b' }),
    ).rejects.toThrow('binary');
    expect(
      await readPocketFile({ name: 'notes', size: 15000, text: async () => 'a'.repeat(15000) }),
    ).toMatchObject({ truncated: true, text: 'a'.repeat(11000) });
  });
});

it('keeps the entire approved passage and wrapper within the chat input budget', () => {
  const message = passageMessage({ name: 'x'.repeat(180), text: 'z'.repeat(11000) });
  expect(message.length).toBeLessThanOrEqual(12000);
  expect(message).toContain('z'.repeat(11000));
  expect(message.endsWith('</file_passage>')).toBe(true);
});
