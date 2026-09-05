import { spawn } from 'node:child_process';
import electron from 'electron';
const url = 'http://localhost:5173';
const deadline = Date.now() + 60_000;
while (true) {
  try {
    if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break;
  } catch {}
  if (Date.now() > deadline)
    throw new Error(
      'Web app unavailable at localhost:5173. Start the web and API dev servers first.',
    );
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const child = spawn(electron, ['.', '--dev'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
