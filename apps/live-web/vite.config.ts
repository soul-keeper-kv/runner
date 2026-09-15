import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The workspace talks to the Runner API through a proxy so the browser
    // sees one origin: no CORS handling, and the WebSocket upgrade works the
    // same in development as it does behind a reverse proxy in production.
    proxy: {
      '/api': {
        target: process.env.VITE_RUNNER_API_URL ?? 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
      '/openapi.json': {
        target: process.env.VITE_RUNNER_API_URL ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
