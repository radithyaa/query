/**
 * Build SPA dashboard (SRS §3.2: React + TanStack Router + TanStack Query + Tailwind,
 * SPA yang disajikan sebagai static assets Workers).
 *
 * - `base: '/'` karena aset dipublikasikan dari root Worker (`/assets/...`).
 * - Routing memakai route tree code-based di `src/router.tsx` (bukan file-based),
 *   sehingga plugin generator TanStack tidak diperlukan.
 * - `outDir: dist` adalah `assets.directory` pada `wrangler*.jsonc` dan
 *   `scripts/http-static.ts` (runtime Node).
 * - API dan SSE sama-origin; saat `npm run dev` (Vite) diproksikan ke
 *   `scripts/node-server.ts` di port 8787.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env['PORTFOLIO_API'] ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@portfolio/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsDir: 'assets',
    // muat portofolio < 3 detik (NFR-9): jaga bundle tetap kecil
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/healthz': { target: api, changeOrigin: true },
    },
  },
});
