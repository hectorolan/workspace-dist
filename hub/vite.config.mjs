import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite build for the hub SPA (client/ → dist/). Express serves dist/ behind
 * the auth wall (src/app.js); `npm run build` must run before `npm start` serves
 * the UI. The dev server proxies the backend so `npm run dev` gives HMR against
 * a locally running Express (AUTH_BYPASS=true npm start in another terminal —
 * the real Google flow only works on the registered port 8080).
 */
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
});
