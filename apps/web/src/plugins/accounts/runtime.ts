export type AccountProvider = 'notion' | 'google' | 'github';
export type AccountItem = { id: string; title: string; url?: string; text?: string };
export type AccountResult = { label?: string; items: AccountItem[]; truncated?: boolean };
export type AccountOperation = { operation: 'search' | 'read'; query?: string; id?: string };
export type AccountActivity = {
  id: string;
  provider: AccountProvider;
  label: string;
  status: 'active' | 'complete' | 'error';
};
export type AccountConnection = {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  label?: string;
  error?: string;
  busy?: boolean;
};
export const accountProviders: AccountProvider[] = ['notion', 'google', 'github'];
export const accountNames = { notion: 'Notion', google: 'Google Drive', github: 'GitHub' };
const OAUTH_KEY = 'little-brain.account-oauth';
const empty = (): Record<AccountProvider, AccountConnection> => ({
  notion: { status: 'disconnected' },
  google: { status: 'disconnected' },
  github: { status: 'disconnected' },
});
export type AccountSnapshot = {
  connections: Record<AccountProvider, AccountConnection>;
  googleOAuthAvailable: boolean;
  notionOAuthAvailable: boolean;
  oauthError: string;
};
export class AccountRuntime {
  private credentials: Partial<Record<AccountProvider, string>> = {};
  private epochs = { notion: 0, google: 0, github: 0 };
  private controllers = new Map<AbortController, AccountProvider | undefined>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private oauth: Partial<
    Record<'google' | 'notion', { clientId: string; redirectUri: string } | null>
  > = {};
  private snapshot: AccountSnapshot = {
    connections: empty(),
    googleOAuthAvailable: false,
    notionOAuthAvailable: false,
    oauthError: '',
  };
  readonly storageKey: string;
  constructor(
    private settings: { endpoint: string; token: string },
    private activity?: (event: AccountActivity) => void,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
    private storage: Storage = sessionStorage,
  ) {
    this.storageKey =
      'little-brain.account-session:' + (settings.endpoint || window.location.origin);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  setActivity(callback?: (event: AccountActivity) => void) {
    this.activity = callback;
  }
  private update(provider: AccountProvider, value: AccountConnection) {
    if (this.disposed) return;
    this.snapshot = {
      ...this.snapshot,
      connections: { ...this.snapshot.connections, [provider]: value },
    };
    this.listeners.forEach((fn) => fn());
  }
  private persist() {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.credentials));
    } catch {
      /* Memory-only access still works if session storage is unavailable. */
    }
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    if (this.disposed) throw new Error('Account connection was closed.');
    const controller = new AbortController();
    this.controllers.set(controller, (body as { provider?: AccountProvider })?.provider);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await this.fetcher(`${this.settings.endpoint}/api/accounts/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.settings.token ? { Authorization: `Bearer ${this.settings.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
      const data = await result.json();
      if (controller.signal.aborted) throw new Error('Account request was cancelled.');
      if (!result.ok)
        throw new Error(typeof data.error === 'string' ? data.error : 'Account request failed.');
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Account request was cancelled or timed out.');
      if (error instanceof Error) throw error;
      throw new Error('Account request failed. Check your connection.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
    }
  }
  async initialize() {
    let saved: any = {};
    try {
      saved = JSON.parse(this.storage.getItem(this.storageKey) || '{}');
    } catch {}
    const callback = new URL(window.location.href);
    const provider = callback.searchParams.get('account_oauth');
    const isCallback = provider === 'google' || provider === 'notion';
    const code = callback.searchParams.get('code'),
      state = callback.searchParams.get('state'),
      denied = callback.searchParams.has('error');
    let pending: any = null;
    if (isCallback) {
      try {
        pending = JSON.parse(this.storage.getItem(OAUTH_KEY) || 'null');
        this.storage.removeItem(OAUTH_KEY);
      } catch {}
      for (const key of [
        'account_oauth',
        'code',
        'state',
        'scope',
        'authuser',
        'prompt',
        'error',
        'error_description',
      ])
        callback.searchParams.delete(key);
      window.history.replaceState(null, '', callback.pathname + callback.search + callback.hash);
    }
    await Promise.all(
      accountProviders
        .filter((p) => !(isCallback && p === provider))
        .map(async (p) => {
          if (typeof saved?.[p] === 'string')
            try {
              await this.connect(p, saved[p]);
            } catch {}
        }),
    );
    try {
      const config = await this.request('config', {});
      this.oauth = { google: config.google || null, notion: config.notion || null };
      if (this.disposed) return;
      this.snapshot = {
        ...this.snapshot,
        googleOAuthAvailable: Boolean(this.oauth.google),
        notionOAuthAvailable: Boolean(this.oauth.notion),
      };
      this.listeners.forEach((fn) => fn());
      if (isCallback) {
        if (denied) throw new Error('Account sign-in was cancelled or denied.');
        if (
          !pending ||
          !code ||
          state !== pending.state ||
          pending.provider !== provider ||
          typeof pending.createdAt !== 'number' ||
          pending.createdAt > Date.now() ||
          Date.now() - pending.createdAt > 10 * 60 * 1000 ||
          pending.endpoint !== this.settings.endpoint
        )
          throw new Error(
            'Account sign-in expired or its security check failed. Start sign-in again.',
          );
        const data = await this.request(`${provider}-exchange`, {
          code,
          verifier: pending.verifier,
        });
        await this.connect(provider, data.credential);
      }
    } catch (error) {
      if (this.disposed) return;
      this.snapshot = {
        ...this.snapshot,
        oauthError:
          error instanceof Error ? error.message : 'Could not load account sign-in settings.',
      };
      this.listeners.forEach((fn) => fn());
    }
  }
  async connect(provider: AccountProvider, credential: string) {
    const value = credential.trim();
    const epoch = ++this.epochs[provider];
    delete this.credentials[provider];
    this.persist();
    this.update(provider, { status: 'connecting' });
    try {
      const result: AccountResult = await this.request('run', {
        provider,
        operation: 'verify',
        credential: value,
      });
      if (this.disposed || epoch !== this.epochs[provider])
        throw new Error('Connection was cancelled.');
      if (!result.label) throw new Error('Account identity could not be verified.');
      this.credentials[provider] = value;
      this.persist();
      this.update(provider, { status: 'connected', label: result.label });
    } catch (error) {
      if (epoch === this.epochs[provider])
        this.update(provider, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Could not connect account.',
        });
      throw error;
    }
  }
  disconnect = (provider: AccountProvider) => {
    ++this.epochs[provider];
    this.controllers.forEach((p, c) => {
      if (p === provider) c.abort();
    });
    delete this.credentials[provider];
    this.persist();
    this.update(provider, { status: 'disconnected' });
  };
  async run(
    provider: AccountProvider,
    operation: AccountOperation,
    signal?: AbortSignal,
  ): Promise<AccountResult> {
    const credential = this.credentials[provider];
    if (!credential) throw new Error(`Connect ${accountNames[provider]} in Connections first.`);
    if (this.snapshot.connections[provider].busy)
      throw new Error('This account is busy. Wait for its current request to finish.');
    const epoch = this.epochs[provider],
      previous = this.snapshot.connections[provider];
    const event: AccountActivity = {
      id: crypto.randomUUID(),
      provider,
      label: `${operation.operation === 'search' ? 'Searching' : 'Reading'} ${accountNames[provider]}`,
      status: 'active',
    };
    this.activity?.(event);
    this.update(provider, { ...previous, busy: true, error: undefined });
    try {
      const result = await this.request('run', { ...operation, provider, credential }, signal);
      if (epoch !== this.epochs[provider] || this.disposed)
        throw new Error('Account was disconnected while the request was running.');
      this.update(provider, { ...previous, busy: false, error: undefined });
      this.activity?.({ ...event, status: 'complete' });
      return result;
    } catch (error) {
      if (epoch === this.epochs[provider])
        this.update(provider, {
          ...previous,
          busy: false,
          error: error instanceof Error ? error.message : 'Account request failed.',
        });
      this.activity?.({ ...event, status: 'error' });
      throw error;
    }
  }
  authorizeGoogle = () => this.authorize('google');
  authorizeNotion = () => this.authorize('notion');
  private async authorize(provider: 'google' | 'notion') {
    const config = this.oauth[provider];
    if (!config) throw new Error('Account sign-in is not configured. Use a token below.');
    if (new URL(config.redirectUri).origin !== window.location.origin)
      throw new Error(
        'Account sign-in callback must use this app’s current origin. Check the server redirect URI setting.',
      );
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    const encode = (array: Uint8Array) =>
      btoa(String.fromCharCode(...array))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    const verifier = encode(bytes),
      state = crypto.randomUUID();
    const challenge = encode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    this.storage.setItem(
      OAUTH_KEY,
      JSON.stringify({
        provider,
        state,
        verifier,
        createdAt: Date.now(),
        endpoint: this.settings.endpoint,
      }),
    );
    const url = new URL(
      provider === 'google'
        ? 'https://accounts.google.com/o/oauth2/v2/auth'
        : 'https://api.notion.com/v1/oauth/authorize',
    );
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state,
    });
    if (provider === 'google') {
      params.set('scope', 'https://www.googleapis.com/auth/drive.readonly');
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
      params.set('access_type', 'online');
      params.set('prompt', 'consent');
    } else params.set('owner', 'user');
    url.search = params.toString();
    window.location.assign(url.href);
  }
  activate() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
    this.controllers.forEach((_p, c) => c.abort());
    this.controllers.clear();
    this.credentials = {};
  }
}
