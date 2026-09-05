import { describe, expect, it } from 'vitest';
import { inferDevelopmentUrl, normalizeServerUrl } from './connection';

describe('mobile server connection', () => {
  it('requires HTTPS in production and strips trailing slash', () => {
    expect(normalizeServerUrl(' https://brain.example.com/ ', false)).toBe(
      'https://brain.example.com',
    );
    expect(() => normalizeServerUrl('http://192.168.1.3:5173', false)).toThrow('HTTPS');
    expect(normalizeServerUrl('http://192.168.1.3:5173', true)).toBe('http://192.168.1.3:5173');
  });
  it('rejects secrets, ambiguous paths and non-web schemes', () => {
    for (const url of [
      'https://name:secret@brain.example.com',
      'https://brain.example.com/?token=secret',
      'https://brain.example.com/#secret',
      'https://brain.example.com/app',
      'file:///tmp/app',
      'javascript:alert(1)',
    ]) {
      expect(() => normalizeServerUrl(url, true)).toThrow();
    }
  });
  it('uses the Expo host rather than the phone localhost', () => {
    expect(inferDevelopmentUrl('192.168.1.23:8081')).toBe('http://192.168.1.23:5173');
    expect(inferDevelopmentUrl('[::1]:8081')).toBe('http://[::1]:5173');
  });
});
