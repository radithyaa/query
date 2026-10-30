/**
 * Penyajian berkas statis dashboard dari `apps/web/dist` untuk runtime Node.
 * Path dinormalisasi dan dibatasi ke dalam direktori build.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ROOT } from './lib.ts';

export const WEB_DIST = resolve(ROOT, 'apps/web/dist');

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export async function serveAsset(pathname: string): Promise<Response | null> {
  const rel = normalize(decodeURIComponent(pathname).replace(/^\/+/, ''));
  if (rel === '' || rel === '.') return null; // `/` bukan berkas: biarkan fallback SPA
  const file = resolve(join(WEB_DIST, rel));
  if (!file.startsWith(WEB_DIST) || rel.startsWith('..') || !existsSync(file) || !statSync(file).isFile()) return null;
  return new Response(await readFile(file), {
    headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cacheUntuk(rel) },
  });
}

/** `index.html` tidak di-cache; aset ber-hash Vite boleh di-cache panjang. */
function cacheUntuk(rel: string): string {
  if (rel === 'index.html') return 'no-cache';
  return rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

/**
 * Fallback SPA: berkas aset apa adanya; path lain (rute klien) → `index.html`.
 * Dipakai agar reload langsung di `/saas/<id>` atau `/audit` tetap membuka dashboard.
 */
export async function serveAssetAtauSpa(pathname: string): Promise<Response | null> {
  if (!existsSync(resolve(WEB_DIST, 'index.html'))) return serveAsset(pathname);
  const langsung = await serveAsset(pathname);
  if (langsung) return langsung;
  if (/\.[a-z0-9]+$/i.test(pathname)) return null; // permintaan berkas yang memang tidak ada
  return serveAsset('/index.html');
}
