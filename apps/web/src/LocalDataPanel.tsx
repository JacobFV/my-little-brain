import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Workspace } from '@little-brain/core';
import {
  archiveAndSave,
  MAX_BACKUP_BYTES,
  mergeBackup,
  parseLocalBackup,
  exportLocalBackup,
  restoreAuxiliary,
  type LocalBackup,
  WORKSPACE_KEY,
} from './localData';
import { nativeStorageRequest } from './nativeStorage';

function download(text: string, name: string) {
  if (window.ReactNativeWebView) {
    void nativeStorageRequest('export', text).catch((error) => alert(error.message));
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export default function LocalDataPanel({
  workspace,
  setWorkspace,
  storageError = '',
}: {
  workspace: Workspace;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  storageError?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<LocalBackup | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const date = () => new Date().toISOString().slice(0, 10);
  return (
    <section className="local-data-panel" aria-label="Local data">
      <h3>Local data</h3>
      <p>
        Your twins and conversations are saved on this device. Local files and backups are not
        encrypted by this app. Device protection and browser storage policies still apply.
      </p>
      <p>
        Live conversations send selected context to your configured server and OpenAI. HTTPS
        encrypts network transport; keeping a local copy does not make those conversations offline
        or end-to-end encrypted.
      </p>
      {(storageError || error) && <p role="alert">{error || storageError}</p>}
      {message && <p role="status">{message}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          onClick={() => {
            try {
              download(
                JSON.stringify(exportLocalBackup(workspace, localStorage), null, 2),
                `little-brain-${date()}.json`,
              );
              setMessage(
                'Backup download requested. Check that the file was saved; it contains every twin, conversation, activity entry, saved task, attention level and preference (excluding access tokens).',
              );
            } catch {
              download(JSON.stringify(workspace, null, 2), `little-brain-workspace-${date()}.json`);
              setMessage(
                'Workspace exported from memory. Some saved preferences or tasks could not be read.',
              );
            }
          }}
        >
          Export all twins
        </button>
        <button onClick={() => input.current?.click()}>Import backup</button>
        <button
          onClick={async () => {
            try {
              if (!navigator.storage?.persist) {
                setMessage(
                  'This browser does not offer persistent-storage requests. Keep downloaded backups.',
                );
                return;
              }
              const granted = await navigator.storage.persist();
              setMessage(
                granted
                  ? 'The browser granted persistent storage. You can still lose data by clearing site data or uninstalling; keep backups.'
                  : 'The browser did not grant persistent storage. Keep downloaded backups.',
              );
            } catch {
              setError('The browser could not request persistent storage.');
            }
          }}
        >
          Request persistent storage
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setError('');
          setPending(null);
          try {
            if (file.size > MAX_BACKUP_BYTES)
              throw new Error('This backup exceeds the 12 MB import limit.');
            setPending(parseLocalBackup(await file.text()));
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'The backup could not be read.');
          }
        }}
      />
      {pending && (
        <div aria-label="Review backup import">
          <p>
            Import {pending.workspace.twins.length} twin
            {pending.workspace.twins.length === 1 ? '' : 's'} and{' '}
            {pending.workspace.twins.reduce((n, t) => n + t.messages.length, 0)} messages? Existing
            twins stay intact. Identical twins are skipped; conflicting versions become separate
            copies.
          </p>
          <button
            onClick={() => {
              try {
                const merged = mergeBackup(workspace, pending.workspace);
                restoreAuxiliary(pending, localStorage);
                setWorkspace(merged);
                window.dispatchEvent(new Event('little-brain.local-data-restored'));
                setPending(null);
                setMessage(
                  'Backup added to this window. Check for any storage error before closing.',
                );
              } catch (failure) {
                setError(
                  failure instanceof Error ? failure.message : 'The backup could not be merged.',
                );
              }
            }}
          >
            Add imported twins
          </button>{' '}
          <button onClick={() => setPending(null)}>Cancel import</button>
        </div>
      )}
      <details>
        <summary>Recover a storage problem</summary>
        <p>
          Export this window first. You can also download the exact saved copy, even when it cannot
          be read. Archiving keeps those bytes under a separate recovery key before saving this
          window’s workspace.
        </p>
        <button
          onClick={() => {
            try {
              const raw = localStorage.getItem(WORKSPACE_KEY);
              if (raw === null) setMessage('No saved browser copy exists.');
              else download(raw, `little-brain-saved-copy-${date()}.json`);
            } catch {
              setError('The saved copy could not be read.');
            }
          }}
        >
          Download saved copy
        </button>
        <button onClick={() => setConfirmRecovery(true)}>
          Archive saved copy and use this window
        </button>
        {confirmRecovery && (
          <div>
            <p>
              This saves the workspace currently shown in this window as the active copy. The old
              saved copy is retained if storage has room. Continue?
            </p>
            <button
              onClick={() => {
                try {
                  const raw = archiveAndSave(localStorage, workspace);
                  window.dispatchEvent(
                    new CustomEvent('little-brain.storage-recovered', { detail: raw }),
                  );
                  setError('');
                  setMessage('The previous saved copy was archived and this workspace was saved.');
                  setConfirmRecovery(false);
                } catch {
                  setError(
                    'Recovery could not be saved. The active saved copy was left intact if the archive failed; download backups before clearing any storage.',
                  );
                }
              }}
            >
              Archive and save
            </button>{' '}
            <button onClick={() => setConfirmRecovery(false)}>Cancel</button>
          </div>
        )}
      </details>
    </section>
  );
}
