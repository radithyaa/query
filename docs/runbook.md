# Runbook

## Menjalankan lokal

```bash
npm run seed          # idempoten: dilewati bila sudah ada SaaS Unit
npm start             # PORT=8787 default; --port 9000 untuk mengganti
curl -X POST localhost:8787/api/v1/login -H 'content-type: application/json' -d '{"role":"owner"}'
```

`LOCAL_DB_PATH` menentukan berkas SQLite (default `.data/portfolio.db`; `:memory:` untuk sekali pakai).
Data contoh membuat tiga SaaS Unit: sehat (`laporanku`), menurun (`kasirku`), dan sudah
intervensi (`notaku`).

## Cek kesehatan

| Pemeriksaan | Perintah / endpoint | Harapan |
| --- | --- | --- |
| Aplikasi & DB | `GET /healthz` | `200`, `db: true` |
| Rantai audit | `GET /api/v1/audit/verify` (pemilik) | `valid: true` |
| Antrean & biaya | `GET /api/v1/ops/metrics` (pemilik) | `antrean`, `dead_letter`, `persetujuan_menunggu`, `biaya_agen_30hari_usd` |
| Portofolio | `GET /api/v1/portfolio/summary` | `units` dengan `skor`, `peringkat` |

## Siklus harian

- Otomatis di Workers: Cron `0 1 * * *` (08.00 WIB) → `scheduled` → `runCycle`.
- Manual: `POST /api/v1/cycle` (pemilik, `Idempotency-Key`) atau
  `npm run agent:run -- --cycle [--queued]`.
- Satu agen: `npm run agent:run -- --saas <slug> --fungsi <review|support|promosi|kode|parent>`.

Siklus aman diulang; job dan laporan dikunci per tanggal (`saas:fungsi:jenis:tanggal`).

## Persetujuan

1. `GET /api/v1/approvals` (status `menunggu`).
2. Dashboard: tombol **Setujui / Minta revisi / Tolak**, atau
   `POST /api/v1/approvals/{id}/decision` `{"keputusan":"setujui","catatan":"..."}`.
3. Kategori `sunset`, `merge_pr`, `ubah_harga`, `beli_iklan`, `rc_plan` hanya untuk pemilik.
4. TTL default 72 jam (`APPROVAL_TTL_JAM`/`APPROVAL_TTL_JAM`); yang kedaluwarsa tidak dijalankan (FR-9.3).

Rencana pemulihan (`rc_plan`) muncul otomatis saat sebuah SaaS Unit masuk `intervensi`; menyetujuinya
memindahkan status ke `percobaan` dan mengunci tenggat.

## Sunset

1. Health engine membuat `sunset_case` saat masa percobaan lewat tanpa kriteria bangkit.
2. `GET /api/v1/sunset` → paket bukti.
3. Keputusan pemilik: `POST /api/v1/sunset/{id}/decision` dengan `mfa_token` (token Access dengan
   klaim `mfa: true`, atau `dev-*` di lokal).
4. Tahap berikutnya: `POST /api/v1/sunset/{id}/advance` (pengumuman → tutup_pendaftaran → ekspor
   → penagihan → takedown → arsip). Tahap `arsip` menetapkan status `dihentikan`.

## Kill switch

- Global: `POST /api/v1/killswitch` `{"aktif":true,"alasan":"..."}`.
- Per SaaS: sertakan `"saas_id"`. Jeda manual per SaaS: `POST /api/v1/saas/{id}/pause` / `/resume`.
- Efek: gateway menolak semua tindakan tulis seketika, siklus tidak menjadwalkan job, dan job yang
  berjalan dibatalkan sebelum agen menerima permintaan model (tercatat `job.dibatalkan`).

## Dead-letter & retry

Pesan yang gagal 3 kali dipindah ke topik `agent_jobs_dlq` (`job_queue`). Periksa dengan
`GET /api/v1/ops/metrics` (`dead_letter > 0` → alert). Isi DLQ dapat diperiksa di tabel
`job_queue WHERE topic = 'agent_jobs_dlq'`; setelah penyebab diperbaiki, hapus baris DLQ dan
buat ulang job dengan menghapus `agent_job.idem_key` terkait atau menunggu tanggal berikutnya.

## Pemulihan database

- Lokal: salin `.data/portfolio.db` sebelum eksperimen. Migrasi idempoten (`npm run migrate`).
- D1: Time Travel (`wrangler d1 time-travel restore`) untuk plan berbayar; ekspor audit berkala ke
  R2 sebagai salinan append-only.

## Migrasi ke Cloudflare

```bash
npm run build
cd apps/api
npx wrangler d1 execute portfolio --remote --yes --file=../../migrations/0001_init.sql
npx wrangler deploy --config wrangler.production.jsonc
npx wrangler secret put JWT_SECRET            # ≥16 karakter
npx wrangler secret put ANTHROPIC_API_KEY     # opsional
```

Pastikan `database_id` dan `assets.directory` sesuai. Setelah deploy, cek `/healthz` dan `/`
(`/dashboard` dialihkan permanen ke `/`).

## Insiden umum

| Gejala | Kemungkinan penyebab | Tindakan |
| --- | --- | --- |
| Dashboard 401 | token tidak ada/kedaluwarsa | `POST /api/v1/login` (lokal) atau masuk lewat Access |
| Semua tindakan `tolak` dengan `killswitch:*` | kill switch aktif | `POST /api/v1/killswitch` `{"aktif":false,...}` |
| `anggaran:habis` | anggaran fungsi terpakai penuh | naikkan `anggaran_bulanan_usd` lewat `PATCH /api/v1/saas/{id}/config` |
| `data tidak cukup` pada evaluasi | metrik hilang / konektor mati | cek `GET /api/v1/saas/{id}/metrics`, `terakhir_sehat` konektor |
| job `dead` bertambah | konektor/model error berulang | lihat `audit_log` tindakan `job.gagal`, perbaiki, jalankan siklus lagi |
