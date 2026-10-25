// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, createElement } from 'react';
import { AccountRuntime } from './runtime';
import { useAccounts } from './useAccounts';
const credential = 'provider-token-fixture';
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
describe('account credential lifecycle', () => {
  it('stores only verified credentials in session storage and removes them on disconnect', async () => {
    const runtime = new AccountRuntime(
      { endpoint: '', token: 'server-token' },
      undefined,
      async () => reply({ label: 'Person', items: [] }),
    );
    await runtime.connect('notion', credential);
    expect(runtime.getSnapshot().connections.notion).toEqual({
      status: 'connected',
      label: 'Person',
    });
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain(credential);
    expect(sessionStorage.getItem(runtime.storageKey)).toContain(credential);
    expect(localStorage.length).toBe(0);
    runtime.disconnect('notion');
    expect(sessionStorage.getItem(runtime.storageKey)).not.toContain(credential);
    await expect(runtime.run('notion', { operation: 'search' })).rejects.toThrow('Connect Notion');
    runtime.dispose();
  });
  it('does not store rejected tokens or resurrect a connection after disconnect', async () => {
    const runtime = new AccountRuntime({ endpoint: '', token: '' }, undefined, async () =>
      reply({ error: 'Invalid credential' }, 401),
    );
    await expect(runtime.connect('google', credential)).rejects.toThrow('Invalid credential');
    expect(sessionStorage.getItem(runtime.storageKey)).not.toContain(credential);
    let resolve!: (value: Response) => void;
    const delayed = new AccountRuntime(
      { endpoint: '', token: '' },
      undefined,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = delayed.connect('github', credential);
    delayed.disconnect('github');
    resolve(reply({ label: 'Person', items: [] }));
    await expect(pending).rejects.toThrow('cancelled');
    expect(delayed.getSnapshot().connections.github.status).toBe('disconnected');
    runtime.dispose();
    delayed.dispose();
  });
  it('reports real activity success and supports cancellation without returning late provider results', async () => {
    const activity = vi.fn();
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) =>
      JSON.parse(String(init?.body)).operation === 'verify'
        ? reply({ label: 'Person', items: [] })
        : new Promise<Response>((r) => {
            resolve = r;
          }),
    );
    const runtime = new AccountRuntime({ endpoint: '', token: '' }, activity, fetcher);
    await runtime.connect('github', credential);
    const pending = runtime.run('github', { operation: 'read', id: 'owner/repo' });
    runtime.disconnect('github');
    resolve(reply({ items: [{ id: 'owner/repo', title: 'Private README', text: 'private' }] }));
    await expect(pending).rejects.toThrow(/disconnected|cancelled/);
    expect(activity.mock.calls.map((v) => v[0].status)).toEqual(['active', 'error']);
    runtime.dispose();
  });
  it('survives StrictMode initialization and keeps callable methods stable', async () => {
    sessionStorage.setItem(
      'little-brain.account-session:' + window.location.origin,
      JSON.stringify({ github: credential }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('config') ? reply({ google: null }) : reply({ label: 'Octocat', items: [] }),
      ),
    );
    const hook = renderHook(() => useAccounts({ endpoint: '', token: '' }), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    });
    const run = hook.result.current.run;
    await waitFor(() => expect(hook.result.current.connections.github.status).toBe('connected'));
    expect(hook.result.current.run).toBe(run);
    act(() => hook.result.current.disconnect('github'));
    expect(hook.result.current.connections.github.status).toBe('disconnected');
  });
  it('rejects OAuth callback state mismatch and strips authorization code from history', async () => {
    window.history.replaceState(null, '', '/?account_oauth=google&code=private-code&state=wrong');
    sessionStorage.setItem(
      'little-brain.account-oauth',
      JSON.stringify({
        state: 'expected',
        verifier: 'a'.repeat(43),
        createdAt: Date.now(),
        endpoint: '',
      }),
    );
    const fetcher = vi.fn(async () =>
      reply({
        google: { clientId: 'id', redirectUri: window.location.origin + '/?account_oauth=google' },
      }),
    );
    const runtime = new AccountRuntime({ endpoint: '', token: '' }, undefined, fetcher);
    await runtime.initialize();
    expect(runtime.getSnapshot().oauthError).toContain('security check failed');
    expect(window.location.search).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
  it('binds stored credentials to the configured server origin', async () => {
    sessionStorage.setItem(
      'little-brain.account-session:https://old.test',
      JSON.stringify({ github: credential }),
    );
    const fetcher = vi.fn(async () => reply({ google: null }));
    const runtime = new AccountRuntime(
      { endpoint: 'https://new.test', token: '' },
      undefined,
      fetcher,
    );
    await runtime.initialize();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      'https://new.test/api/accounts/config',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    ]);
    expect(runtime.getSnapshot().connections.github.status).toBe('disconnected');
    runtime.dispose();
  });
});

it('invokes the browser fetch function without binding it to AccountRuntime', async () => {
  vi.stubGlobal('fetch', function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(reply({ google: null }));
  });
  const runtime = new AccountRuntime({ endpoint: '', token: '' });
  await runtime.initialize();
  expect(runtime.getSnapshot().oauthError).toBe('');
  runtime.dispose();
});

it.each(['google', 'notion'] as const)(
  'finishes a valid %s callback and verifies identity before saving access',
  async (provider) => {
    window.history.replaceState(
      null,
      '',
      `/?account_oauth=${provider}&code=private-code&state=expected`,
    );
    sessionStorage.setItem(
      'little-brain.account-oauth',
      JSON.stringify({
        provider,
        state: 'expected',
        verifier: 'a'.repeat(43),
        createdAt: Date.now(),
        endpoint: '',
      }),
    );
    const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('config'))
        return reply({
          [provider]: {
            clientId: 'id',
            redirectUri: window.location.origin + `/?account_oauth=${provider}`,
          },
        });
      if (String(url).endsWith('-exchange')) return reply({ credential });
      expect(JSON.parse(String(init?.body))).toEqual({ provider, operation: 'verify', credential });
      return reply({ label: 'Verified identity', items: [] });
    });
    const runtime = new AccountRuntime({ endpoint: '', token: 'app-token' }, undefined, fetcher);
    await runtime.initialize();
    expect(runtime.getSnapshot().connections[provider].status).toBe('connected');
    expect(runtime.getSnapshot().oauthError).toBe('');
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('little-brain.account-oauth')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain(credential);
    runtime.dispose();
  },
);
it('rejects an explicitly cancelled tool call even if a transport returns a late response', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) =>
    JSON.parse(String(init?.body)).operation === 'verify'
      ? reply({ label: 'Person', items: [] })
      : new Promise<Response>((r) => {
          resolve = r;
        }),
  );
  const runtime = new AccountRuntime({ endpoint: '', token: '' }, undefined, fetcher);
  await runtime.connect('github', credential);
  const controller = new AbortController();
  const pending = runtime.run('github', { operation: 'search' }, controller.signal);
  controller.abort();
  resolve(reply({ items: [] }));
  await expect(pending).rejects.toThrow('cancelled');
  expect(runtime.getSnapshot().connections.github.busy).toBe(false);
  runtime.dispose();
});
