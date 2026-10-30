/**
 * Penyajian dashboard SPA (§3.2, FR-7): pengalihan URL lama `/dashboard`, aset
 * hasil build Vite (`apps/web/dist`), fallback halaman ringkas saat build belum
 * ada, dan fallback SPA di Worker ketika binding `ASSETS` tidak tersedia.
 *
 * `appAset` membangun rute aset yang sama dengan `app.ts` di atas Hono kosong,
 * sehingga `c.env` berisi binding per permintaan (di `buildApp`, `env` diikat
 * oleh middleware aplikasi).
 */
import { describe, expect, it } from 'vitest';
import { LocalDatabase, migrate } from '@portfolio/db';
import { Hono } from 'hono';
import { buildApp } from '../src/app.ts';
import { createWorker } from '../src/index.ts';
import { buatRepositori, readEnv, type Bindings } from '../src/env.ts';
import { publishAssets } from '../src/services/assets.ts';

type BindingAset = { fetch: (req: Request) => Promise<Response> };

/** Binding `ASSETS` tiruan; mencatat semua path yang diminta. */
function assetsTiruan(opts: { isi?: Record<string, string>; kosong?: boolean; gagal?: boolean } = {}) {
  const isi = opts.isi ?? {
    '/index.html': '<!doctype html><html><body><div id="root"></div></body></html>',
    '/assets/index-abc.js': 'console.log("spa")',
    '/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  };
  const panggilan: string[] = [];
  const binding: BindingAset = {
    fetch: async (req) => {
      const url = new URL(req.url);
      panggilan.push(url.pathname);
      if (opts.gagal) throw new Error('binding gagal');
      if (opts.kosong) return new Response('<html><body>direktori</body></html>', { status: 200 });
      const body = isi[url.pathname];
      return body === undefined ? new Response('tidak ada', { status: 404 }) : new Response(body, { status: 200 });
    },
  };
  return { binding, panggilan };
}

async function envBaru(): Promise<Bindings> {
  const db = new LocalDatabase(':memory:');
  await migrate(db);
  const env = readEnv({ DB: db, MOCK_CONNECTORS: 'true', JWT_SECRET: 'tes-spa-secret-0123456789', APP_NAME: 'Uji SPA', NOTIFICATION_CHANNEL: 'log' });
  env.repos = buatRepositori(db);
  return env;
}

/** Rute aset yang sama dengan `app.ts`, dengan `env` eksplisit per permintaan. */
async function appAset(assets?: BindingAset) {
  const app = new Hono();
  app.get('/assets/*', (c) => publishAssets(c as never, c.req.path.replace(/^\//, '')));
  app.get('/app.js', (c) => publishAssets(c as never, 'app.js'));
  app.get('/styles.css', (c) => publishAssets(c as never, 'styles.css'));
  app.get('/favicon.svg', (c) => publishAssets(c as never, 'favicon.svg'));
  app.get('/', (c) => publishAssets(c as never, 'index.html'));
  const env = await envBaru();
  const bindings = (assets ? { ...env, ASSETS: assets } : env) as never;
  return async (path: string) => app.request(path, {}, bindings);
}

describe('penyajian dashboard SPA', () => {
  it('/dashboard dialihkan permanen ke SPA, /dashboard/:id ke detail unit', async () => {
    const { binding } = assetsTiruan();
    const app = buildApp();
    const env = { ...(await envBaru()), ASSETS: binding } as never;
    const res = await app.request('/dashboard', {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/');
    const unit = await app.request('/dashboard/unit-1', {}, env);
    expect(unit.status).toBe(301);
    expect(unit.headers.get('location')).toBe('/saas/unit-1');
  });

  it('aset diteruskan ke binding dengan path absolut dan header cache berbeda', async () => {
    const { binding, panggilan } = assetsTiruan();
    const req = await appAset(binding);

    const js = await req('/assets/index-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log("spa")');

    const svg = await req('/favicon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('cache-control')).toBe('public, max-age=3600');

    const html = await req('/');
    expect(html.status).toBe(200);
    expect(html.headers.get('cache-control')).toBe('no-cache');
    expect(await html.text()).toContain('id="root"');

    expect(panggilan).toEqual(expect.arrayContaining(['/assets/index-abc.js', '/favicon.svg', '/index.html']));
  });

  it('aset hilang atau binding gagal → 404 JSON, bukan index.html', async () => {
    const r1 = await (await appAset(assetsTiruan().binding))('/assets/tidak-ada.js');
    expect(r1.status).toBe(404);
    expect(((await r1.json()) as { error: { kode: string } }).error.kode).toBe('not_found');

    const r2 = await (await appAset(assetsTiruan({ gagal: true }).binding))('/favicon.svg');
    expect(r2.status).toBe(404);
  });

  it('tanpa build, halaman ringkas berbasis data disajikan tanpa cache', async () => {
    const res = await (await appAset())('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Portofolio SaaS');
    expect(html).toContain('Belum ada SaaS Unit');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('binding ASSETS yang menunjuk direktori kosong tidak menutupi halaman ringkas', async () => {
    const res = await (await appAset(assetsTiruan({ kosong: true }).binding))('/');
    expect(await res.text()).toContain('Belum ada SaaS Unit');
  });

  it('Worker: API lewat Hono, aset lewat binding, rute halaman pakai fallback SPA tanpa binding', async () => {
    const { binding } = assetsTiruan();
    const worker = createWorker();
    const ctx = { waitUntil: () => undefined } as never;

    const denganAssets = { ...(await envBaru()), ASSETS: binding } as never;
    const api = await worker.fetch(new Request('https://uji.local/healthz'), denganAssets, ctx);
    expect(api.status).toBe(200);

    const aset = await worker.fetch(new Request('https://uji.local/favicon.svg'), denganAssets, ctx);
    expect(aset.status).toBe(200);

    const tanpaAssets = (await envBaru()) as never;
    const halaman = await worker.fetch(new Request('https://uji.local/saas/abc'), tanpaAssets, ctx);
    expect(halaman.status).toBe(200);
    expect(await halaman.text()).toContain('Belum ada SaaS Unit');
  });
});
