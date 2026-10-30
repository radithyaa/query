# Arsitektur

Dokumen ini menjelaskan cara komponen tersambung di implementasi saat ini. Rujukan nomor
bagian mengacu ke [`SRS Sistem Agen Induk Portofolio SaaS.md`](./SRS%20Sistem%20Agen%20Induk%20Portofolio%20SaaS.md).

## 1. Lapisan

| Lapisan | Lokasi | Tanggung jawab |
| --- | --- | --- |
| Kontrak | `packages/shared` | Skema Zod metrik/konfigurasi/request, konstanta status & fungsi, Health engine murni (`computeHealth`, `decideTransition`, `evaluateResurrection`) |
| Penyimpanan | `packages/db` | Antarmuka `Database` (bind/run/all/first/batch/exec/chain) yang sama dengan D1, driver SQLite lokal, migrasi, repositori, audit append-only + rantai hash |
| Agen | `packages/agents` | Definisi tool + matriks izin, loop tool use dengan batas langkah/token/anggaran, kebijakan anti injection, golden set |
| Konektor | `packages/connectors` | Play, GitHub, Instagram, Sentry, Billing, Analytics (mock deterministik + HTTP) |
| API | `apps/api` | Hono `/api/v1`, middleware auth/peran/rate limit/idempotensi, policy gateway, orkestrator, Health engine runtime, Durable Object guard |
| Dashboard | `apps/web` | SPA React 19 + TanStack Router/Query + Tailwind 4: portofolio, detail, antrean persetujuan, sunset, biaya, laporan, log audit, SSE. Dibangun Vite; aset ber-hash di `apps/web/dist/assets` |
| Operasi | `scripts` | Server Node, seed, migrasi, build, smoke, runner agen |

Inti (`shared`, `db`, `agents`, `connectors`, sebagian besar `apps/api`) tidak mengimpor
modul Cloudflare; adapter khusus platform (D1, Durable Objects, Queues, Workflows) terisolasi
di `wrangler*.jsonc` dan `apps/api/src/do/`.

## 2. Siklus harian

`Orchestrator.runCycle()` (`apps/api/src/orchestrator/cycle.ts`) menjalankan:

1. **Pemulihan** — job `running` yang melewati 4× timeout ditandai `failed`; permintaan
   persetujuan yang lewat `kedaluwarsa` ditandai `kedaluwarsa`.
2. **Ingest metrik** — konektor billing/analytics/play ditarik; blok yang gagal dikirim `null`
   (bukan nol) dan konektornya tidak ditandai sehat. Metrik divalidasi `DailyMetric` lalu
   di-`upsert` ke `metric_daily`. Idempoten per `(saas_id, tanggal)`.
3. **Penjadwalan job** — untuk tiap SaaS Unit dengan status yang boleh berjalan
   (`aktif`, `pengawasan`, `intervensi`, `percobaan`) dan tidak dijeda/kill switch:
   satu job per fungsi aktif + `promosi_mingguan`. Kunci idempoten
   `saas_id:fungsi:jenis:tanggal` mencegah duplikasi; event `agent.job.requested` diterbitkan
   dan pesan masuk ke `job_queue`.
4. **Evaluasi Health** — `HealthEngine.evaluate()` menghitung `computeHealth`, membaca riwayat
   evaluasi, mengevaluasi kriteria bangkit dan konektor utama, lalu memanggil `decideTransition`.
   Hasil disimpan ke `health_evaluation`; perubahan status diterapkan `applyStatus()` dan
   diaudit.
5. **Konsumsi antrean** — `consumeJobs()` mengambil pesan dengan lease, menjalankan agen,
   kemudian `ack`. Gagal → backoff eksponensial (maks 3 percobaan) → dead-letter `agent_jobs_dlq`.
6. **Laporan** — Agen Induk menyusun laporan harian (`report`), idempoten per tanggal.

Setiap keputusan gateway, keputusan persetujuan, perubahan status, dan kegagalan job menulis
`audit_log` dan event ke `event_log` (`/api/v1/events` untuk dashboard SSE).

## 3. Policy gateway

`decideGateway()` (`apps/api/src/services/gateway-core.ts`) adalah fungsi murni yang diuji
sebagai tabel keputusan. Urutan pemeriksaan (penolakan lebih awal menang):

1. kill switch global → 2. kill switch SaaS → 3. status SaaS (`dihentikan`, `diarsipkan`,
   `dalam_sunset` selain tindakan sunset) → 4. matriks izin fungsi §3.6 → 5. jeda per SaaS →
6. rate limit → 7. anggaran (habis, biaya > sisa, 100% terpakai) → 8. tindakan HITL wajib →
9. tingkat otonomi (`draf`, `persetujuan`, `otonom terbatas`).

`evaluateGateway()` (`orchestrator/gateway.ts`) menyiapkan konteks dari tabel (kill switch,
status, anggaran, rate limit), membuat baris `approval` saat keputusan `perlu_persetujuan`
(di-reuse bila `idemKey` sama masih menunggu), serta menerbitkan `approval.requested`.

Rate limit tindakan agen dibaca lewat `GuardLike` (`do/guard.ts`): `DurableObjectGuard`
(DO `SaasGuard` per SaaS) di Workers, `SqlGuard` (tabel `rate_limit`) di Node/test. Keduanya
memakai `hitunganRateLimit()` yang sama sehingga jendela per menit identik. Kill switch global
lintas SaaS tetap dibaca dari tabel.

Keputusan pemilik diproses `Orchestrator.decideApproval()`: hanya baris `menunggu` dan belum
kedaluwarsa yang dapat berubah (atomik), lalu efek tulis dijalankan (mis. konten menjadi
`dijadwalkan`). Keputusan `rc_plan` mengunci `percobaan` + tenggat baru.

## 4. Health engine & sunset

- Status hanya berubah lewat `HealthEngine` atau keputusan pemilik.
- `intervensi` → `percobaan` hanya setelah pemilik menyetujui rencana pemulihan
  (approval `rc_plan` di `workflow_state` dengan kunci `rc_plan:<saas_id>`).
- `percobaan` + tenggat lewat → `usulan_sunset` + `sunset_case` berisi paket bukti
  (tren, pelanggan, perkiraan biaya lanjut, opsi) dan event `sunset.proposed`.
- `pengecualian_sunset` di konfigurasi menahan usulan sunset (kembali ke `intervensi`).
- Keputusan sunset: `POST /api/v1/sunset/{id}/decision` — hanya pemilik + MFA. Setuju →
  `dalam_sunset` + tahap `pengumuman`; tolak/pengecualian → `intervensi` + tenggat baru.
  `POST /api/v1/sunset/{id}/advance` menjalankan tahap FR-8.6 berurutan hingga `arsip`
  (status `dihentikan`).

## 5. Runtime

- **Node** (`scripts/node-server.ts`): HTTP dibangun dari `node:http`, `app.fetch` Hono menjadi
  handler, database SQLite lokal. Endpoint tambahan `POST /api/v1/login` menerbitkan token HS256
  pengembangan (bukan untuk produksi).
- **Workers** (`apps/api/src/index.ts`): `fetch` + `scheduled` (Cron `0 1 * * *` → `runCycle`).
  Binding `DB` diperlakukan sebagai antarmuka `Database`; `chain()` untuk rantai audit aman
  karena D1 memproses kueri satu per satu.

## 6. Batasan implementasi saat ini

Fitur yang sengaja belum disambungkan ke runtime (lihat [`CHECKLIST.md`](./CHECKLIST.md)):

- Durable Object `SaasGuard` (`apps/api/src/do/`) sudah menjadi kelas Worker yang diekspor dari
  `index.ts`; state murni di `stateguard.ts`, adapter klien di `guard.ts`. `buatGuard()` memilih DO
  bila binding `SAAS_GUARD` tersedia (Workers) dan `SqlGuard` bila tidak (Node/test). Yang belum:
  rate limit HTTP middleware (`rateLimit` di `middleware/http.ts`) masih berbasis tabel, bukan DO.
- Antrean memakai `job_queue` di D1, bukan Cloudflare Queues (binding `JOBS` hanya dideklarasikan).
- Cloudflare Workflows (alur panjang `waitForEvent`) belum dipakai; persetujuan tetap bekerja
  lewat tabel + dashboard. Binding workflow dinonaktifkan di `wrangler*.jsonc`.
- Konektor tiket Support dan kanal notifikasi (email/Telegram/WhatsApp) masih mock.
