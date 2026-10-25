import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts', 'src/preload.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  bundle: true,
  external: ['electron'],
  sourcemap: true,
});
