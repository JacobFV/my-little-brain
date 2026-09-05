import { describe, it, expect } from 'vitest';
import { loadSettings } from './settings';
describe('settings recovery', () => {
  it('starts even when browser storage is blocked', () => {
    const blocked = {
      getItem() {
        throw new Error('SecurityError');
      },
    };
    expect(loadSettings(blocked, blocked, false, '').token).toBe('');
  });
  it('ignores malformed or null stored settings', () => {
    for (const raw of ['null', '[]', 'false', '{bad'])
      expect(
        loadSettings({ getItem: () => raw }, { getItem: () => null }, false, '').showThoughts,
      ).toBe(false);
  });
  it('rejects unusable connection origins and clamps panel widths', () => {
    const saved = JSON.stringify({
      endpoint: 'javascript:bad',
      chatWidth: 1000,
      showThoughts: true,
    });
    const result = loadSettings({ getItem: () => saved }, { getItem: () => null }, false, '');
    expect(result.endpoint).toBe('');
    expect(result.chatWidth).toBe(560);
    expect(result.showThoughts).toBe(true);
  });
});
