import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Read VITE_* values from the repository root .env (only VITE_-prefixed keys reach the client).
// Relative to the project root (apps/web); npm workspace scripts run with that cwd.
const envDir = '../..';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_');
  // cortex² research API: same-origin `/v1` in dev unless VITE_CORTEX_API points elsewhere.
  const research = env.VITE_CORTEX_RESEARCH_PROXY || 'http://127.0.0.1:8080';
  return {
    envDir,
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: 'http://127.0.0.1:4318', ws: true },
        ...(env.VITE_CORTEX_API ? {} : { '/v1': { target: research, changeOrigin: true } }),
      },
    },
    build: { chunkSizeWarningLimit: 1200 },
  };
});
