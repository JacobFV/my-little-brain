// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginsPanel } from './PluginsPanel';
afterEach(cleanup);
it('shows media progress and failures at the connection controls and opens a portal', () => {
  const portal = vi.fn();
  render(
    <PluginsPanel
      platform="web"
      cameraActive={false}
      voiceActive={false}
      onCamera={vi.fn()}
      onVoice={vi.fn()}
      onPortal={portal}
      onShare={async () => true}
      cameraError="Camera permission was denied."
      voiceStatus="Requesting microphone permission…"
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('Camera permission was denied');
  expect(screen.getByRole('status').textContent).toContain('Requesting microphone');
  expect(screen.queryByText('Brain circle')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open portal' }));
  expect(portal).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Open a file' })).toBeTruthy();
});
