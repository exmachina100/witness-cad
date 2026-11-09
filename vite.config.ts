import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: { exclude: ['manifold-3d'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // ASCII-only output: escapes stray non-ASCII characters in bundled libraries
  esbuild: { charset: 'ascii' },
  server: { port: 5173 },
});
