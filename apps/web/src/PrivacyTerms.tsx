export function PrivacyTerms({ onBack }: { onBack: () => void }) {
  return (
    <div className="privacy-terms">
      <p>
        Your journal stays on your device. Backups are unencrypted; export a copy before clearing
        app data.
      </p>
      <p>
        OpenAI receives conversation context, voice audio, and content you share through connected
        tools. Camera detection stays local; detected labels enter context. Open brain portals share
        rendered workspace snapshots.
      </p>
      <p>
        Account credentials stay in this browser session and pass through your configured server to
        the provider. Disconnect removes the local credential; revoke access with the provider to
        end it everywhere.
      </p>
      <nav aria-label="Provider terms">
        <a href="https://openai.com/policies/services-agreement/" target="_blank" rel="noreferrer">
          OpenAI terms ↗
        </a>
        <a href="https://www.notion.com/terms" target="_blank" rel="noreferrer">
          Notion terms ↗
        </a>
        <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">
          Google terms ↗
        </a>
        <a
          href="https://docs.github.com/en/site-policy/github-terms/github-terms-of-service"
          target="_blank"
          rel="noreferrer"
        >
          GitHub terms ↗
        </a>
      </nav>
      <button className="outline-button" onClick={onBack}>
        Back to settings
      </button>
    </div>
  );
}
