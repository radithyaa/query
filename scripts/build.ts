/**
 * Build produksi.
 *
 *  1. Dashboard: SPA React (TanStack Router/Query + Tailwind 4) dibangun Vite dari
 *     `apps/web` ke `apps/web/dist` (aset ber-hash di `assets/`, `index.html`
 *     sebagai entri). Direktori ini adalah `assets.directory` pada
 *     `wrangler*.jsonc` dan disajikan `scripts/http-static.ts` di runtime Node.
 *  2. API: bundle `apps/api/src/index.ts` ke `dist/api/index.js` (format ESM,
 *     platform neutral) untuk `wrangler deploy`.
 *
 * `--dashboard` hanya membangun dashboard (dipakai `npm run dashboard`).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { ROOT } from './lib.ts';

const WEB_ROOT = resolve(ROOT, 'apps/web');
const WEB_DIST = resolve(WEB_ROOT, 'dist');
const API_DIST = resolve(ROOT, 'dist/api');

async function buildDashboard(): Promise<string[]> {
  await viteBuild({ configFile: resolve(WEB_ROOT, 'vite.config.ts'), logLevel: 'warn', mode: 'production' });
  const entri = resolve(WEB_DIST, 'index.html');
  if (!existsSync(entri)) throw new Error('build dashboard gagal: apps/web/dist/index.html tidak dibuat');
  return [entri];
}

async function buildApi(): Promise<string[]> {
  const result = await esbuild({
    entryPoints: [resolve(ROOT, 'apps/api/src/index.ts')],
    outfile: resolve(API_DIST, 'index.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser', 'import'],
    external: ['node:sqlite'],
    sourcemap: false,
    logLevel: 'warning',
    tsconfig: resolve(ROOT, 'tsconfig.json'),
  });
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.text).join('\n'));
  return [resolve(API_DIST, 'index.js')];
}

const hanyaDashboard = process.argv.includes('--dashboard');
const hasil: string[] = [];
hasil.push(...(await buildDashboard()));
if (!hanyaDashboard) hasil.push(...(await buildApi()));
console.log(JSON.stringify({ level: 'info', msg: 'build.selesai', berkas: hasil }));
