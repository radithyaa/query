/**
 * Entrypoint aplikasi (§3.4): API Hono, handler terjadwal (`scheduled`), health
 * check, dan kelas Durable Object `SaasGuard`.
 *
 * `main` di `wrangler.jsonc` menunjuk bundle dari berkas ini, jadi semua kelas
 * yang disebut `durable_objects`/`migrations` wajib diekspor di sini —
 * `SaasGuard` untuk §11.5.
 */
import { buildApp } from './app.ts';
import { apiContext } from './context.ts';
import type { Bindings } from './env.ts';
import { Hono } from 'hono';
import { optionalAuth, requestContext, type AppEnv } from './middleware/http.ts';
import { serveSpa } from './services/assets.ts';

export const app = buildApp();

/** Worker khusus aset/SPA (dipakai `createWorker` bila tidak ada binding `ASSETS`). */
const spa = new Hono<AppEnv>();
spa.use('*', requestContext);
spa.use('*', optionalAuth);
spa.get('*', (c) => serveSpa(c));

/** Durable Object guard per SaaS Unit (§11.5); binding `SAAS_GUARD`. */
export { SaasGuard } from './do/saas-guard.ts';

/**
 * Siklus harian terjadwal (Cron Trigger `0 1 * * *`). Menjalankan orkestrasi
 * lengkap; aman dipanggil berulang karena idempoten per tanggal.
 */
export async function runScheduledCycle(env: Bindings, tanggal?: string): Promise<unknown> {
  const { orchestrator } = apiContext(env);
  return orchestrator.runCycle(tanggal ? { tanggal } : {});
}

export interface ScheduledControllerLike {
  cron?: string;
  scheduledTime?: number;
}

export interface ExecutionContextLike {
  waitUntil: (p: Promise<unknown>) => void;
}

export interface WorkersHandler {
  fetch: typeof app.fetch;
  scheduled: (controller: ScheduledControllerLike, env: Bindings, ctx: ExecutionContextLike) => Promise<void>;
}

/** Bentuk `export default` yang dipakai `wrangler deploy` (modul ES). */
export function createWorker(): WorkersHandler {
  return {
    fetch: ((request: Request, env: Bindings, executionCtx?: never) => {
      const url = new URL(request.url);
      // Rute API/health ditangani Hono. Rute lain: static assets (`index.html`
      // untuk path tak dikenal) bila binding ada; jika tidak, fallback SPA di Hono.
      const keApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
      if (keApi) return app.fetch(request, env, executionCtx as never);
      if (env?.ASSETS) return env.ASSETS.fetch(request);
      return spa.fetch(request, env, executionCtx as never);
    }) as WorkersHandler['fetch'],
    async scheduled(_controller, env, ctx) {
      ctx.waitUntil(
        runScheduledCycle(env).catch((error: unknown) => {
          console.error(JSON.stringify({ level: 'error', msg: 'cron.gagal', pesan: error instanceof Error ? error.message : String(error) }));
        }),
      );
    },
  };
}

const worker = createWorker();
export default worker;
