import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AccountRuntime, type AccountActivity } from './runtime';
export function useAccounts({
  endpoint,
  token,
  onActivity,
}: {
  endpoint: string;
  token: string;
  onActivity?: (event: AccountActivity) => void;
}) {
  const runtime = useMemo(() => new AccountRuntime({ endpoint, token }), [endpoint, token]);
  runtime.setActivity(onActivity);
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  useEffect(() => {
    runtime.activate();
    const timer = setTimeout(() => {
      void runtime.initialize();
    }, 0);
    return () => {
      clearTimeout(timer);
      runtime.dispose();
    };
  }, [runtime]);
  const methods = useMemo(
    () => ({
      connect: runtime.connect.bind(runtime),
      disconnect: runtime.disconnect,
      run: runtime.run.bind(runtime),
      authorizeGoogle: runtime.authorizeGoogle,
      authorizeNotion: runtime.authorizeNotion,
    }),
    [runtime],
  );
  return { ...snapshot, ...methods };
}
export type Accounts = ReturnType<typeof useAccounts>;
