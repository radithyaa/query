/**
 * Penyajian SPA dashboard (FR-7). Pada Workers, `ASSETS` adalah binding static
 * assets; pada Node, `apps/web/dist` disajikan langsung.
 *
 * - Rute non-API memakai fallback SPA: `index.html` untuk semua path yang bukan
 *   berkas aset. Di Workers fallback itu ditangani binding static assets
 *   (`assets.not_found_handling: "single-page-application"`), jadi path halaman
 *   tidak dirutekan ke Hono; `serveSpa` dipakai saat tidak ada binding `ASSETS`
 *   (uji/pratinjau). `/dashboard` (URL lama) dialihkan permanen ke SPA.
 * - Aset ber-hash Vite (`assets/index-<hash>.js`) di-cache panjang; `index.html`
 *   selalu `no-cache` agar deploy baru langsung terpakai.
 * - Bila dashboard belum dibangun, halaman ringkas berbasis data tetap disajikan
 *   agar alur end-to-end lokal dapat dicoba tanpa build.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/http.ts';
import { apiContext } from '../context.ts';
import { portfolioSummary } from './summary.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** True bila path menunjuk berkas aset, bukan rute halaman. */
export function tampakAset(path: string): boolean {
  return /\.(?:js|css|svg|png|ico|json|map|woff2)$/.test(path);
}

function cacheUntuk(path: string): string {
  if (path === 'index.html') return 'no-cache';
  // berkas di `assets/` diberi hash oleh Vite → aman di-cache lama
  return path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}


/**
 * Aset dashboard: `path` relatif ke `apps/web/dist` (mis. `assets/index-x.js`).
 * Rute halaman memanggil dengan `index.html`.
 *
 * Header cache selalu disetel ulang: aset ber-hash Vite boleh di-cache panjang,
 * `index.html` dan halaman ringkas tidak boleh di-cache.
 */
export async function publishAssets(c: Context<AppEnv>, path: string): Promise<Response> {
  const aset = c.env?.ASSETS;
  // Hanya `index.html` yang jatuh ke halaman ringkas; aset lain harus benar-benar ada.
  const halamanUtama = path === 'index.html';
  if (aset) {
    const url = new URL(c.req.url);
    url.pathname = `/${path}`;
    try {
      const res = await aset.fetch(new Request(url.toString()));
      // Hanya entri SPA yang diterima; 404/500 atau HTML lain → halaman ringkas.
      if (res.ok && (!halamanUtama || (await mengandungMarkerSpa(res)))) {
        const headers = new Headers(res.headers);
        headers.set('cache-control', cacheUntuk(path));
        if (!headers.has('content-type')) headers.set('content-type', contentType(path));
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
    } catch {
      // binding gagal (mis. direktori build hilang): jatuh ke halaman ringkas
    }
  }
  if (!halamanUtama) return c.json({ error: { kode: 'not_found', pesan: `aset ${path} tidak ditemukan` } }, 404);
  return new Response(await renderOverview(c), {
    headers: { 'content-type': CONTENT_TYPES['.html']!, 'cache-control': 'no-cache' },
  });
}

/**
 * Binding static assets yang menunjuk direktori tanpa `index.html` (mis. ESM
 * kosong) menjawab 200 untuk `/index.html`; pastikan isinya benar-benar entri SPA.
 */
async function mengandungMarkerSpa(res: Response): Promise<boolean> {
  try {
    const isi = await res.clone().text();
    return isi.includes('id="root"') || isi.includes("id='root'");
  } catch {
    return false;
  }
}

/** Fallback SPA: aset apa adanya, rute halaman → `index.html` (200, bukan 404). */
export async function serveSpa(c: Context<AppEnv>): Promise<Response> {
  const path = c.req.path.replace(/^\//, '');
  if (path !== '' && tampakAset(path)) return publishAssets(c, path);
  return publishAssets(c, 'index.html');
}

function esc(value: unknown): string {
  return String(value ?? '—').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Halaman HTML ringkas (tanpa build): portofolio + antrean persetujuan + laporan terakhir. */
export async function renderOverview(c: Context<AppEnv>): Promise<string> {
  const { repos } = apiContext(c.env);
  const claims = c.get('claims');
  const hanya = claims?.role === 'operator' && claims.saas.length > 0 ? claims.saas : null;
  const summary = await portfolioSummary(repos, { hanya });
  const approvals = await repos.approval.list({ status: 'menunggu', limit: 20 });
  const report = await repos.report.latest(summary.tanggal);
  const kill = await repos.kill.state();
  const ringkasan = (report?.isi as { ringkasan_portofolio?: string } | null)?.ringkasan_portofolio ?? 'Belum ada laporan hari ini.';

  const baris = summary.units
    .map(
      (u) => `<tr>
        <td><strong>${esc(u.nama)}</strong><br><span class="muted">${esc(u.slug)}</span></td>
        <td><span class="badge ${esc(u.peringkat)}">${esc(u.status_label)}</span></td>
        <td class="num">${u.skor === null ? '—' : esc(u.skor)}</td>
        <td class="num">${u.mrr === null ? '—' : esc(u.mrr)}</td>
        <td class="num">${u.mrr_tren_persen === null ? '—' : `${u.mrr_tren_persen > 0 ? '+' : ''}${esc(u.mrr_tren_persen)}%`}</td>
        <td class="num">${u.rating === null ? '—' : esc(u.rating)}</td>
        <td class="num">$${esc(u.biaya_agen_usd)}</td>
        <td>${u.komponen_lemah.map((k) => `${esc(k.label)} (${esc(k.score)})`).join('<br>') || '—'}</td>
      </tr>`,
    )
    .join('');

  const antrean = approvals
    .map(
      (a) => `<li><strong>${esc(a.jenis)}</strong> · ${esc(a.ringkasanDampak)} <span class="muted">saas ${esc(a.saasId.slice(0, 8))} · kedaluwarsa ${new Date(a.kedaluwarsa).toISOString().slice(0, 16).replace('T', ' ')} UTC</span></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portofolio SaaS — ${esc(c.env.APP_NAME)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfc; --fg:#16181d; --muted:#6b7280; --line:#e5e7eb; --card:#fff; --ok:#0f7b4f; --warn:#a16207; --bad:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e6e8ec; --muted:#9aa3af; --line:#242833; --card:#161922; } }
  body { margin:0; font:15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--fg); }
  header, main { max-width: 1080px; margin: 0 auto; padding: 0 20px; }
  header { padding-top: 28px; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  .muted { color: var(--muted); font-size: 12px; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-top:16px; }
  .card { background: var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card .k { color: var(--muted); font-size:12px; }
  .card .v { font-size: 22px; font-weight: 600; }
  table { width:100%; border-collapse: collapse; background: var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); font-size:13px; vertical-align: top; }
  th { color: var(--muted); font-weight:600; font-size:12px; }
  .num { text-align:right; font-variant-numeric: tabular-nums; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid currentColor; font-size:12px; }
  .badge.sehat { color: var(--ok); } .badge.pengawasan { color: var(--warn); } .badge.kritis { color: var(--bad); } .badge.tidak_diketahui { color: var(--muted); }
  ul { margin:0; padding-left:18px; } li { margin:6px 0; }
  .alert { border-left:3px solid var(--bad); padding:8px 12px; background: var(--card); border-radius:6px; }
  footer { max-width:1080px; margin: 28px auto; padding: 0 20px 40px; color: var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>${esc(c.env.APP_NAME)}</h1>
  <span class="muted">Portofolio SaaS · ${esc(summary.tanggal)}</span>
</header>
<main>
  ${kill.global ? `<p class="alert"><strong>Kill switch global aktif.</strong> ${esc(kill.globalAlasan)}</p>` : ''}
  <div class="cards">
    <div class="card"><div class="k">SaaS Unit</div><div class="v">${esc(summary.total)}</div></div>
    <div class="card"><div class="k">Sehat</div><div class="v">${esc(summary.sehat)}</div></div>
    <div class="card"><div class="k">Perlu perhatian</div><div class="v">${esc(summary.perlu_perhatian)}</div></div>
    <div class="card"><div class="k">Skor rata-rata</div><div class="v">${summary.skor_rata2 === null ? '—' : esc(summary.skor_rata2)}</div></div>
    <div class="card"><div class="k">Biaya agen 30 hari</div><div class="v">$${esc(summary.biaya_agen_30hari_usd)}</div></div>
    <div class="card"><div class="k">Persetujuan menunggu</div><div class="v">${esc(summary.persetujuan_menunggu)}</div></div>
  </div>

  <h2>Ringkasan Agen Induk</h2>
  <div class="card">${esc(ringkasan)}</div>

  <h2>Portofolio</h2>
  <table>
    <thead><tr><th>SaaS Unit</th><th>Status</th><th class="num">Skor</th><th class="num">MRR</th><th class="num">Tren</th><th class="num">Rating</th><th class="num">Biaya</th><th>Komponen lemah</th></tr></thead>
    <tbody>${baris || '<tr><td colspan="8" class="muted">Belum ada SaaS Unit.</td></tr>'}</tbody>
  </table>

  <h2>Antrean persetujuan</h2>
  <div class="card">${antrean ? `<ul>${antrean}</ul>` : '<span class="muted">Tidak ada permintaan yang menunggu.</span>'}</div>
</main>
<footer>Halaman ringkas karena dashboard belum dibangun (<code>npm run build</code>). Endpoint: <code>/api/v1/portfolio/summary</code>, <code>/api/v1/approvals</code>, <code>/api/v1/events</code> (SSE).</footer>
</body>
</html>`;
}
