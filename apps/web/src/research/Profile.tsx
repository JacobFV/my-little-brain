import { useCallback, useEffect, useState } from 'react';
import { FileText, Trash2, Upload, X } from 'lucide-react';
import { IconButton } from '../components';
import { ApiError, type CortexClient, type ProfileDoc } from './api';

const TEXT_EXT = /\.(txt|md|markdown|json|csv)$/i;
const MAX_CHARS = 200_000;

/** "About me" drawer: personal notes the brain can read (text files or pasted text). */
export function ProfileDrawer({
  client,
  onClose,
  onUnauthorized,
}: {
  client: CortexClient;
  onClose: () => void;
  onUnauthorized: () => void;
}) {
  const [docs, setDocs] = useState<ProfileDoc[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      setMsg(
        e instanceof ApiError && (e.status === 404 || e.status === 503)
          ? 'My memory for personal notes is still booting — try again in a minute.'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    },
    [onUnauthorized],
  );
  const load = useCallback(() => {
    client
      .profileDocs()
      .then(setDocs)
      .catch(() => {});
  }, [client]);
  useEffect(load, [load]);

  const add = async (n: string, t: string) => {
    if (!t.trim()) return;
    setBusy(true);
    setMsg('');
    try {
      const doc = await client.addProfileDoc(n.trim() || 'Note', t.slice(0, MAX_CHARS));
      setDocs((d) => [doc, ...d.filter((x) => x.id !== doc.id)]);
      setMsg(`Saved “${doc.name}” (${doc.chars.toLocaleString()} chars).`);
      return true;
    } catch (e) {
      handle(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const onFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      if (!TEXT_EXT.test(f.name)) {
        setMsg(`${f.name}: unsupported type — I can read .txt, .md, .json and .csv for now.`);
        continue;
      }
      await add(f.name, await f.text());
    }
  };

  return (
    <div className="cx-drawer-backdrop" onClick={onClose}>
      <aside
        className="cx-drawer"
        role="dialog"
        aria-label="About me"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cx-drawer-head">
          <h3>About me</h3>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <p className="cx-drawer-note">
          Things you share here become part of what your brain knows about you — it uses them to
          interpret your EEG and to pick experiments.
        </p>
        <label className="cx-upload">
          <Upload size={15} />
          <span>Upload .txt / .md / .json / .csv</span>
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <div className="cx-paste">
          <input
            placeholder="Title (e.g. Sleep diary)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            placeholder="…or paste text about yourself: routines, health notes, what you're curious about"
            value={text}
            rows={5}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="primary-button cx-primary"
            disabled={busy || !text.trim()}
            onClick={async () => {
              if (await add(name, text)) (setText(''), setName(''));
            }}
          >
            Save note
          </button>
        </div>
        {msg && <small className="cx-note">{msg}</small>}
        <div className="cx-doc-list">
          {!docs.length ? (
            <div className="cx-empty-line">Nothing shared yet.</div>
          ) : (
            docs.map((d) => (
              <div key={d.id} className="cx-doc">
                <FileText size={14} />
                <span>
                  <strong>{d.name}</strong>
                  <small>
                    {d.chars.toLocaleString()} chars · {new Date(d.created_at).toLocaleDateString()}
                  </small>
                </span>
                <IconButton
                  label={`Delete ${d.name}`}
                  onClick={() =>
                    client
                      .deleteProfileDoc(d.id)
                      .then(() => setDocs((all) => all.filter((x) => x.id !== d.id)))
                      .catch(handle)
                  }
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
