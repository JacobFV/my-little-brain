import { it, expect } from 'vitest';
import { allowsBrowserMedia } from './browserPolicy';
it('requires explicit matching media grant, focus, same plugin contents and exact HTTPS origin', () => {
  const state = {
    focused: true,
    mediaOrigin: 'https://example.com',
    media: { microphone: true, camera: false },
  };
  expect(
    allowsBrowserMedia(state, true, 'https://example.com/path', 'https://example.com', 'audio'),
  ).toBe(true);
  expect(
    allowsBrowserMedia(state, true, 'https://example.com', 'https://example.com', 'video'),
  ).toBe(false);
  expect(
    allowsBrowserMedia(state, false, 'https://example.com', 'https://example.com', 'audio'),
  ).toBe(false);
  expect(
    allowsBrowserMedia(
      { ...state, focused: false },
      true,
      'https://example.com',
      'https://example.com',
      'audio',
    ),
  ).toBe(false);
  expect(
    allowsBrowserMedia(state, true, 'https://example.com', 'https://other.example', 'audio'),
  ).toBe(false);
  expect(
    allowsBrowserMedia(state, true, 'https://other.example', 'https://example.com', 'audio'),
  ).toBe(false);
  expect(allowsBrowserMedia(state, true, 'http://example.com', 'http://example.com', 'audio')).toBe(
    false,
  );
  expect(
    allowsBrowserMedia(state, true, 'https://example.com', 'https://example.com', 'unknown'),
  ).toBe(false);
});
