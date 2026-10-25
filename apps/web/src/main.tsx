import React from 'react';
import ReactDOM from 'react-dom/client';
import ResearchLab from './research/ResearchLab';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import './styles.css';
class AppBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="fatal">
        <h1>A little brain freeze.</h1>
        <p>Your saved thoughts are still on this device. Reload to try again.</p>
        <button onClick={() => location.reload()}>Reload My Little Brain</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppBoundary>
      <ResearchLab />
    </AppBoundary>
  </React.StrictMode>,
);
