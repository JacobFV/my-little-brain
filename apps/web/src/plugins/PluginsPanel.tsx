import { useRef, useState } from 'react';
import { Camera, Mic, FileText, Users, Globe, Monitor, Image, Activity, Plug } from 'lucide-react';
import { plugins, pluginStatus, readPocketFile, passageMessage, type Platform } from './catalog';
const icons = [Camera, Mic, FileText, Users, Globe, Monitor, Image, Activity];
export function PluginsPanel({
  platform,
  cameraActive,
  voiceActive,
  onCamera,
  onVoice,
  onCircle,
  onShare,
  openBrowser,
}: {
  platform: Platform;
  cameraActive: boolean;
  voiceActive: boolean;
  onCamera: () => void;
  onVoice: () => void;
  onCircle: () => void;
  onShare: (text: string) => Promise<boolean>;
  openBrowser?: (url: string, options?: { allowControl?: boolean }) => Promise<void>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('https://www.wikipedia.org');
  const [allowControl, setAllowControl] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState('');
  const action = (id: string) => {
    setError('');
    setNotice('');
    if (id === 'camera') onCamera();
    if (id === 'voice') onVoice();
    if (id === 'circle') onCircle();
    if (id === 'files') picker.current?.click();
    if (id === 'browser' && openBrowser)
      void openBrowser(url, { allowControl })
        .then(() => setNotice('Your little browser is open.'))
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not open browser.'));
  };
  return (
    <div className="feature-page plugins-page">
      <header>
        <Plug size={25} />
        <div>
          <h1>Little connections</h1>
          <p>Give your brains a few new senses and tools.</p>
        </div>
      </header>
      <p className="feature-note">
        You’re on{' '}
        {platform === 'web'
          ? 'the web'
          : platform === 'desktop'
            ? 'desktop'
            : platform === 'ios'
              ? 'iOS'
              : 'Android'}
        . Connections start only when you choose them.
      </p>
      <input
        ref={picker}
        hidden
        type="file"
        accept=".txt,.md,.csv,.json,.log,text/plain,text/markdown,text/csv,application/json"
        onChange={async (event) => {
          const selected = event.target.files?.[0];
          event.target.value = '';
          if (!selected) return;
          try {
            setFile(await readPocketFile(selected));
            setError('');
          } catch (e) {
            setFile(null);
            setError(e instanceof Error ? e.message : 'Could not read file.');
          }
        }}
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {file && (
        <section className="file-preview">
          <h2>{file.name}</h2>
          <p>
            Preview and edit before sharing.{' '}
            {file.truncated ? 'Showing the first 11,000 characters.' : ''}
          </p>
          <textarea
            aria-label="Passage to share"
            value={file.text}
            maxLength={11000}
            onChange={(event) => setFile({ ...file, text: event.target.value })}
          />
          <div className="dialog-actions">
            <button className="outline-button" onClick={() => setFile(null)}>
              Discard
            </button>
            <button
              className="primary-button"
              disabled={sharing || !file.text.trim()}
              onClick={async () => {
                setSharing(true);
                try {
                  const sent = await onShare(passageMessage(file));
                  if (sent) {
                    setFile(null);
                    setNotice('Passage shared with your brain.');
                  } else setError('The passage was not sent. Check the connection and try again.');
                } finally {
                  setSharing(false);
                }
              }}
            >
              {sharing ? 'Sharing…' : 'Share passage with brain'}
            </button>
          </div>
        </section>
      )}
      <div className="plugin-grid">
        {plugins.map((plugin, index) => {
          const status = pluginStatus(plugin, platform),
            Icon = icons[index];
          const active =
            plugin.id === 'camera' ? cameraActive : plugin.id === 'voice' ? voiceActive : false;
          const available = status === 'available' && (plugin.id !== 'browser' || !!openBrowser);
          const label = active
            ? 'Disconnect'
            : plugin.id === 'files'
              ? 'Choose a file'
              : plugin.id === 'circle'
                ? 'Open circle'
                : plugin.id === 'browser'
                  ? 'Open browser'
                  : 'Connect';
          return (
            <section key={plugin.id} className="plugin-card">
              <div className="plugin-title">
                <span>
                  <Icon size={21} />
                </span>
                <h2>{plugin.name}</h2>
                {active && <small>Connected</small>}
              </div>
              <p>{plugin.description}</p>
              <small className="plugin-privacy">{plugin.privacy}</small>
              {plugin.id === 'browser' && available && (
                <>
                  <label className="browser-control-consent">
                    <input
                      type="checkbox"
                      checked={allowControl}
                      onChange={(event) => setAllowControl(event.target.checked)}
                    />
                    Allow this brain to control this browser session
                  </label>
                  <input
                    aria-label="Browser address"
                    type="url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </>
              )}
              <footer>
                <span>
                  {plugin.platforms.length === 4
                    ? 'Everywhere'
                    : plugin.platforms
                        .map((p) => (p === 'desktop' ? 'Desktop' : p === 'ios' ? 'iOS' : 'Android'))
                        .join(' · ')}
                </span>
                <button
                  className={active ? 'outline-button' : 'primary-button'}
                  disabled={!available}
                  onClick={() => action(plugin.id)}
                >
                  {status === 'other-platform'
                    ? 'On ' +
                      plugin.platforms.map((p) => (p === 'desktop' ? 'desktop' : p)).join(' / ')
                    : !available
                      ? 'Coming later'
                      : label}
                </button>
              </footer>
            </section>
          );
        })}
      </div>
    </div>
  );
}
