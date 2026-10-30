# Checklist Implementasi — Sistem Agen Induk untuk Portofolio SaaS

Referensi: `SRS Sistem Agen Induk Portofolio SaaS.md` v0.1.
Pembaruan terakhir: 30 Oktober 2026.

Legenda:
- `[x]` selesai dan ada di repo
- `[~]` kerangka/logika inti sudah ada, tetapi belum tersambung ke runtime (rute/orkestrasi/UI belum)
- `[ ]` belum dikerjakan
- `[–]` di luar lingkup implementasi lokal (butuh resource/produk eksternal)

**Status ringkas saat ini:** aplikasi **dapat dijalankan end-to-end di lokal**: rute HTTP (`app.ts`),
runtime Node (`scripts/node-server.ts`) dan entrypoint Workers (`index.ts`), orkestrator siklus
harian, Health engine runtime + alur sunset, dashboard SPA (React/TanStack/Tailwind), skrip
`build`/`smoke`/`migrate`/`seed`/`agent:run`, konfigurasi Wrangler, CI, dan dokumentasi sudah ada.
**124 test lulus** dan **smoke runtime 40/40 cek lulus**.

Pembaruan 30 Okt 2026 (sesi dashboard):

- Dashboard ditulis ulang sebagai SPA React 19 + TanStack Router/Query + Tailwind 4 + Radix
  (SRS §3.2) dan dibangun Vite; sebelumnya satu berkas `app.js` tanpa framework yang hanya memuat
  sebagian FR-7.
- FR-7.7 dilengkapi di UI: kill switch global/per SaaS, jeda/cabut jeda, keputusan sunset + MFA,
  maju tahap sunset, pendaftaran SaaS Unit, dan siklus harian.
- Filter FR-7.6 disimpan di URL (dapat dibagikan) untuk portofolio, persetujuan, dan audit.
- Bug diperbaiki: cache query terhapus saat login (data tidak pernah tampil), `/` jatuh ke `EISDIR`
  di runtime Node, `index.html`/aset ber-hash tidak diberi header cache, filter SaaS Unit audit
  diabaikan, dan favicon dashboard tidak terkirim.

Pembaruan 30 Okt 2026 (sesi ini):

- Durable Object `SaasGuard` diekspor sebagai kelas Worker dari `index.ts`, dipilih otomatis lewat
  `buatGuard()` (DO bila binding `SAAS_GUARD` ada, `SqlGuard` di Node). Sebelumnya `SqlGuard`
  adalah kode mati dan rate limit orkestrator ditulis inline.
- Dashboard mendapat bagian **Log audit** (filter aktor/tindakan/tanggal, paginasi, verifikasi
  rantai hash). API audit kini mengembalikan `masukan`/`keluaran` sebagai objek, bukan teks JSON.
- Konfigurasi Wrangler diperbaiki: binding `ASSETS` yang terduplikasi (R2 + static assets) diganti
  `AUDIT_BUCKET`, dan binding `DailyRunWorkflow` (kelas belum ada) dinonaktifkan agar deploy tidak gagal.
- `node-server.ts` kini menyajikan dashboard hasil build untuk `/dashboard`.

Indikator verifikasi terakhir (`npm run verify`):
| Pemeriksaan | Hasil |
| --- | --- |
| `npm run typecheck` | ✅ bersih (termasuk `tsconfig.web.json`) |
| `npm test` | ✅ 124 lulus / 7 file |
| `npm run build` | ✅ `apps/web/dist` (Vite) + `dist/api/index.js` |
| `npm run smoke` | ✅ 40/40 cek lulus |
| UI (`npm start` + Chromium headless) | ✅ semua halaman, dialog keputusan/revisi, sunset + MFA, kill switch, mode gelap; 0 galat konsol |
| Server lokal (`npm start` + `seed`) | ✅ dashboard, login, siklus, gateway, sunset diverifikasi manual |

---

## 0. Fondasi repo

- [x] Workspace npm dengan `packages/*` dan `apps/*` (padanan §11.3)
- [x] TypeScript strict + `erasableSyntaxOnly` + `noUncheckedIndexedAccess` di semua paket
- [x] Pemisahan paket: `shared`, `db`, `agents`, `connectors`, `apps/api`, `apps/web`
- [x] Inti tidak bergantung langsung pada Cloudflare (adapter DB & guard); mitigasi risiko single-vendor §8
- [x] Konfigurasi Wrangler (`apps/api/wrangler.jsonc` + varian staging/production)
- [x] `.env.example`
- [x] Script `build`, `smoke`, `migrate`, `seed`, `agent:run` + `node-server`
- [x] `README.md` dan `docs/` (arsitektur, konfigurasi SaaS Unit, kebijakan agen, runbook)

## 1. Model data & kontrak (SRS §6)

- [x] Tabel inti §6.1: `saas_unit`, `connector`, `metric_daily`, `agent_job`, `agent_run`, `agent_memory`, `agent_budget`, `approval`, `health_evaluation`, `sunset_case`, `audit_log`
- [x] Tabel turunan entitas §6: `content_item`, `review`, `pull_request_ref`, `event_log`
- [x] Tabel pendukung: `job_queue`, `idempotency_key`, `workflow_state`, `kill_switch_event`, `golden_case`, `rate_limit`, `notification_outbox`, `report`
- [x] CHECK status SaaS Unit sesuai FR-1.2 (8 status)
- [x] Trigger `audit_log` menolak UPDATE/DELETE — **diuji**
- [x] Rantai hash `hash_sebelumnya` + `verifyChain()` — **diuji** (termasuk penulisan paralel & waktu mundur)
- [x] Indeks `(saas_id, tanggal)`, `(status, kedaluwarsa)`, `(saas_id, fungsi, status)` — terpasang di skema
- [ ] Pengujian indeks tidak dilakukan (tidak ada query performance test)
- [x] Skema metrik harian v1 (Zod) sesuai §6.2, blok metrik boleh `null`/dihilangkan — **diuji**
- [x] DDL Drizzle (`packages/db/src/schema.ts`) sebagai dokumentasi skema
- [x] SQL migrasi untuk D1 (`migrations/0001_init.sql`, dibuat dari `npm run migrate -- --sql`)
- [ ] Migrasi lewat `wrangler d1 migrations` (pipeline memakai `wrangler d1 execute --file`)
- [x] Repositori metrik: upsert + baca, pemetaan aman

## 2. API inti (SRS §7.2)

- [x] Middleware autentikasi JWT (HS256 + JWKS RS256/ES256, issuer/audience/expiry) — **terpasang & diuji**
- [x] Middleware peran + pembatasan SaaS per operator (`requireRole`) — **terpasang & diuji**
- [x] Rate limit berbasis tabel — terpasang di gateway
- [x] Helper `Idempotency-Key` (wajib pada endpoint tulis, divalidasi lebih dulu)
- [x] `app.ts` (Hono)
- [x] `GET/POST /saas`, `GET /saas/:id`, `PATCH /saas/:id/config`
- [x] `POST /saas/{id}/metrics` (+ `GET` untuk riwayat)
- [x] `GET /saas/{id}/status`
- [x] `POST /saas/{id}/pause` dan `/resume`
- [x] `GET /portfolio/summary`
- [x] `GET /approvals`, `POST /approvals/{id}/decision` (sekali pakai, TTL, kategori khusus pemilik)
- [x] `POST /sunset/{id}/decision` (khusus pemilik + MFA), `GET /sunset`, `POST /sunset/{id}/advance`
- [x] `POST /killswitch`, `GET /killswitch`
- [x] `GET /audit`, `GET /audit/verify`
- [x] `GET /events` (SSE, token via header atau `?access_token=`)
- [x] `GET /healthz`, `GET /ops/metrics`, `GET /reports`, `GET /reports/latest`, `POST /cycle`
- [x] `POST /gateway/check` — terpasang & diuji
- [x] Token layanan per job: `POST /service-token` (HS256, TTL ≤ 1 jam, scope SaaS + fungsi)
- [x] Tanda tangan tautan persetujuan (HMAC + kedaluwarsa) dan verifikasi webhook — kode ada, belum diuji
- [ ] Penyimpanan respons idempoten untuk replay result (saat ini: anti-duplikat job/approval)

## 3. Policy gateway (SRS §3.3, §11.5)

- [x] Fungsi keputusan deterministik `decideGateway()` dengan urutan pemeriksaan terdokumentasi
- [x] Kill switch global & per SaaS
- [x] Status SaaS (dihentikan/diarsipkan/dalam_sunset) menolak tindakan
- [x] Matriks izin per fungsi (§3.6) lewat `bolehPakai`
- [x] Anggaran: habis → tolak, perkiraan biaya > sisa → tolak, ≥100% → tolak, peringatan 80%
- [x] Tindakan wajib HITL (FR-9.2) selalu `perlu_persetujuan`
- [x] Tingkat otonomi `draf` / `persetujuan` / `otonom terbatas`
- [x] Pemetaan jenis persetujuan + TTL kedaluwarsa
- [x] Guard: `SqlGuard` (runtime Node) + `SaasGuardState` (Durable Object) — dipilih `buatGuard()`
- [x] **Test tabel keputusan gateway** (§5.8) — `packages/agents/test/gateway.test.ts`
- [x] Integrasi: pembuatan baris `approval` + event `approval.requested` dari gateway (idempoten per `idemKey`)
- [x] Pencatatan `audit_log` otomatis per keputusan dari rute
- [x] Kelas `SaasGuard` diekspor dari `index.ts` sebagai Durable Object; `SqlGuard` dipakai di Node — **diuji** (`apps/api/test/guard.test.ts`)
- [ ] Repositori/orkestrator belum memakai `guard.catatBiaya()` (anggaran masih dicatat orkestrator lewat `BudgetRepo`)

## 4. Agen Unit (SRS §3.5, §4.2–4.5)

- [x] `ModelClient` abstrak + tier model + harga token + MockModelClient + AnthropicClient
- [x] `MockPlanModel` untuk lokal: loop nyata (satu tool lewat gateway) lalu fallback deterministik
- [x] Loop agent generik: batas langkah/token/waktu/anggaran, validasi Zod, jejak
- [x] Kerangka kebijakan §11.2 tertanam di sistem prompt
- [x] Deteksi prompt injection + pembungkusan teks luar sebagai data — **diuji**
- [x] Definisi tool + matriks izin per fungsi — **diuji**
- [x] Agen Review, Support, Promosi, Kode, Parent
- [x] Golden set + uji batas tool — **diuji** di CI
- [x] Memori kerja `agent_memory` (tipe + ringkasan keluaran)
- [x] Penyimpanan memori ke DB setelah run (orkestrator)
- [x] Prompt versi tercatat di `agent_run.versi_prompt` (`PROMPT_VERSI`)
- [x] Koreksi bug `triageAturan`: crash/error → p1, kehilangan data/login/pembayaran → p0 (sesuai golden set)

## 5. Health engine & sunset (SRS FR-8)

- [x] Health Score berbobot + normalisasi min/target — **diuji**
- [x] Komponen invers (churn, rasio biaya) — **diuji**
- [x] Metrik hilang → bobot dinormalkan ulang; >1/3 hilang → data tidak cukup — **diuji**
- [x] Semua transisi tabel FR-8 — **diuji** (unit) dan lewat orkestrasi — **diuji** (aktif→pengawasan→intervensi→percobaan)
- [x] Data tidak cukup & konektor mati menahan evaluasi — **diuji**
- [x] Ambang dapat diubah — **diuji**
- [x] `evaluateResurrection` kriteria bangkit — **diuji**
- [x] Deterministik: hitung ulang dari data historis sama — **diuji**
- [x] Orkestrator evaluasi: ambil metrik → simpan `health_evaluation` → ubah `saas_unit.status`
- [x] Persetujuan rencana pemulihan (approval `rc_plan` → status `percobaan` + tenggat dikunci) — **diuji**
- [x] Paket bukti sunset (tren, biaya, pelanggan, refund, opsi) dari data 28/90 hari
- [x] Eksekusi tahapan sunset FR-8.6 + `sunset_case.tahap` (`/sunset/{id}/advance`)
- [x] Pengecualian sunset (config `pengecualian_sunset`, keputusan `pengecualian`)
- [x] Pencatatan alasan/aktor pada setiap perubahan status (`health_evaluation.alasan` + audit `status.berubah`)

## 6. Orkestrasi & job (SRS §3.3)

- [x] Skema idempotensi job (`agent_job.idem_key UNIQUE`)
- [x] Tabel `job_queue`, `workflow_state`, `idempotency_key` tersedia
- [x] Konstanta jenis job & format kunci `saas:fungsi:jenis:tanggal`
- [x] Orkestrator siklus harian/mingguan (promosi mingguan per minggu ISO)
- [x] Antrean in-process persisten (`job_queue`) + consumer
- [x] Retry + backoff + DLQ + event gagal — **diuji**
- [x] Workflow menunggu persetujuan & dilanjutkan (approval `rc_plan`, `workflow_state`)
- [x] Penjadwal cron (`scheduled` handler, Cron `0 1 * * *`)
- [x] Pemulihan job macet (lease `terlihat_pada` + penandaan `failed`)
- [x] Pembatalan job saat kill switch — **diuji**

## 7. Konektor (SRS §3.1, §7.1)

- [x] Antarmuka konektor Play, GitHub, Instagram, Sentry, Billing, Analytics
- [x] Mock deterministik semua jenis
- [x] Registry memilih mock vs HTTP
- [x] Kerangka HTTP + `ConnectorError`
- [x] Ingest metrik harian dari konektor billing/analytics/play dengan penandaan sehat
- [ ] Konektor tiket/Support sungguhan (masih data tetap di agen)
- [ ] Konektor notification email/Telegram/WhatsApp (sink hanya mock)
- [ ] Pengujian kontrak konektor HTTP

## 8. Dashboard (SRS FR-7)

- [x] SPA React 19 + TanStack Router + TanStack Query + Tailwind 4 (SRS §3.2), dibangun Vite; filter di `search` URL
- [x] Halaman portofolio (Health Score, status, tren MRR, signup, rating, biaya, persetujuan menunggu, komponen lemah) — FR-7.1
- [x] Detail SaaS Unit (status, komponen, grafik MRR/rating, metrik harian, evaluasi, konfigurasi, konektor) — FR-7.2
- [x] Antrean persetujuan dengan isi draf konten/balasan ulasan/PR + setujui/tolak/minta revisi — FR-7.3
- [x] Panel biaya (biaya agen 30 hari per unit terhadap anggaran per fungsi) — FR-7.4 (rincian per fungsi belum diekspos API)
- [x] Log audit: masukan, keluaran, aktor/penyetuju, hash, filter aktor/tindakan/tanggal/SaaS Unit, paginasi, verifikasi rantai — FR-7.5
- [x] Filter periode, SaaS Unit, dan fungsi agen — FR-7.6
- [x] Kill switch global (sidebar) & per SaaS (menu baris), jeda/cabut jeda, keputusan persetujuan/sunset (+MFA), maju tahap sunset — FR-7.7
- [x] SSE live update (`/api/v1/events`) + indikator status koneksi
- [x] Build static assets (`npm run build` → `apps/web/dist`, aset ber-hash immutable) + fallback SPA + halaman ringkas saat belum dibangun
- [x] Fallback SPA (`not_found_handling`) dan pengalihan permanen `/dashboard` → `/`
- [x] `npm run dev:web` (Vite HMR dengan proxy API)
- [x] Test penyajian SPA (`apps/api/test/assets.test.ts`)
- [ ] Halaman publik/landing terpisah
- [ ] Endpoint API untuk riwayat konten/ulasan/PR/insiden per unit (UI menampilkan persetujuan + tautan audit)

## 9. Notifikasi (SRS §5.6)

- [x] Tabel `notification_outbox`
- [x] `MockNotificationSink`
- [x] Notifikasi `approval.requested` ditulis saat gateway membuat permintaan (via event + outbox siap pakai)
- [x] Alert anggaran habis & usulan sunset masuk outbox
- [ ] Adapter email/Telegram/WhatsApp
- [ ] Alert DLQ / lonjakan penolakan / CI gagal beruntun ke kanal eksternal

## 10. Keamanan & kepatuhan (SRS §5.1, §5.4)

- [x] Redaksi PII (email/telepon/kartu) — **diuji**
- [x] Deteksi prompt injection — **diuji otomatis**
- [x] Semua tool tulis lewat gateway; tidak ada tool merge/deploy untuk agen baca — **diuji**
- [x] Kredensial hanya berupa `secret_ref`
- [x] Audit append-only + rantai hash — **diuji**
- [x] Penandaan konten AI (`tanda_ai` di kalender promosi)
- [ ] Ekspor audit ke R2
- [ ] Retensi R2 90 hari (cron belum)
- [x] Rate limit + kill switch — terpasang & **diuji**

## 11. Observabilitas (SRS §5.7)

- [x] Log terstruktur (`requestId`, `run_id`, `saas_id`) di middleware & runner agen
- [x] Metrik operasional (panjang antrean, dead-letter, usia persetujuan, biaya 30 hari, job 7 hari)
- [x] `/api/v1/ops/metrics`
- [ ] Ekspor OpenTelemetry / Langfuse untuk jejak LLM

## 12. Pengujian (SRS §5.8, §9.1)

- [x] `health.test.ts` — 23 test
- [x] `db.test.ts` — 5 test
- [x] `gateway.test.ts` — tabel keputusan (kill switch, status, matriks, anggaran, HITL, otonomi, determinisme 195 kombinasi)
- [x] `guard.test.ts` — `SqlGuard`, `SaasGuardState`, `DurableObjectGuard`, `buatGuard` (11 test)
- [x] `golden.test.ts` — golden set, batas tool, prompt injection, loop agen
- [x] `api.test.ts` — auth, peran, idempotensi, metrik, gateway, persetujuan, sunset, kill switch, siklus, DLQ, audit, dashboard
- [x] `assets.test.ts` — pengalihan `/dashboard`, header cache aset, fallback SPA Worker, halaman ringkas
- [x] Smoke test runtime Node (`npm run smoke`)
- [ ] Alur cerita end-to-end dengan konektor HTTP nyata (staging)

## 13. Deployment (SRS §3.4)

- [x] `wrangler.jsonc` (+ varian `wrangler.staging.jsonc`, `wrangler.production.jsonc`)
- [x] `.github/workflows/ci.yml` dan `deploy.yml`
- [x] Migrasi D1 di pipeline (`wrangler d1 execute --file`)
- [ ] Workflow Agen Kode (Claude Code di Actions)
- [ ] Workflow render video Remotion

## 14. Dokumentasi

- [x] README
- [x] `docs/arsitektur.md`, `docs/konfigurasi-saas-unit.md`, `docs/kebijakan-agen.md`, `docs/runbook.md`

---

## Bug yang ditemukan & diperbaiki saat pengembangan (catatan)

1. **Pemetaan ambang diabaikan** — `mergeDefined` menyalin `berturut`/`pemulihan_berturut` (snake_case dari §11.1) ke `DEFAULT_TRANSITION` camelCase. Diperbaiki dengan `resolveAmbang()`.
2. **Normalisasi komponen invers terbalik** — rumus churn/rasio biaya menghasilkan 0 untuk nilai terbaik. Diperbaiki + test.
3. **Splitter SQL memotong blok trigger** — `BEGIN ... END` inline terpotong di `;` pertama. Ditulis ulang dengan pelacakan kutip, kurung, dan blok trigger, plus test.
4. **`LocalDatabase` tidak diekspor** dari `packages/db` — diperbaiki.
5. **Blok metrik opsional ditolak Zod** — `nullable().optional()` di Zod 4 tetap mewajibkan field di dalam blok yang diisi sebagian. Diganti helper `blok()` (`partial().nullable().optional()`) sesuai §6.2.
6. **Rantai hash audit terputus saat entri ditulis berselang** — `previousHash()` membaca baris terakhir dengan margin waktu; diganti `MAX(id)` + mutex `Database.chain()` dan `waktu` monoton. Ditemukan oleh smoke test.
7. **Triage golden set tidak konsisten** — `triageAturan` memberi p0 untuk crash (golden mengharapkan p1). Aturan diperbaiki.
8. **Middleware log memakai `executionCtx`** — gagal di Node/test ("This context has no ExecutionContext"). Dibuat opsional.
9. **Kuery biaya portofolio memakai kolom yang tidak ada** — `agent_run` tidak punya `saas_id`; diganti join ke `agent_job`.
10. **Urutan validasi ditukar** — `Idempotency-Key` kini diperiksa sebelum body agar klien mendapat galat yang tepat.
11. **Kelas Durable Object tidak pernah diekspor** — `wrangler.jsonc` menunjuk `SaasGuard` tetapi `index.ts` tidak mengekspornya, sehingga deploy gagal. Kelas kini diekspor dan memakai `SaasGuardState` yang dapat diuji; `SqlGuard` yang sebelumnya tidak dipakai menjadi implementasi Node.
12. **Binding `ASSETS` ganda** — dipakai untuk bucket R2 dan static assets pada konfigurasi yang sama. Bucket audit diganti `AUDIT_BUCKET`.
13. **`/dashboard` di runtime Node menyajikan halaman fallback** meski `apps/web/dist` sudah dibangun — path dipetakan ke `index.html`.
14. **Rute audit bertipe query salah** — memakai `z.infer<ListQuery>` untuk `AuditQuery`; kini sesuai tipe dan `dari`/`sampai` divalidasi `YYYY-MM-DD`.
15. **`masukan`/`keluaran` audit berupa teks JSON** — klien dashboard harus mem-parse sendiri; API kini mengembalikan objek.

## Prioritas berikutnya (urutan yang disarankan)

1. Cloudflare Queues (binding `JOBS` sudah dideklarasikan) menggantikan konsumsi `job_queue` + kelas
   `DailyRunWorkflow` (§11.4) — binding workflow sengaja dinonaktifkan sampai kelasnya ada.
2. Konektor nyata: Play Developer API, GitHub App, Instagram Graph, Sentry, Stripe/Midtrans + test kontrak.
3. Adapter notifikasi (email/Telegram/WhatsApp) dan alert otomatis DLQ/anggaran.
4. Ekspor audit ke R2 dan cron retensi 90 hari; endpoint riwayat konten/ulasan/PR per unit.
5. Workflow Agen Kode (Claude Code di Actions) dan render video Remotion.
