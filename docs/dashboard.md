# Dashboard (FR-7)

Dashboard adalah SPA React yang dilayani dari basis kode yang sama dengan API. Dokumen ini
merangkum keputusan implementasi, cara menjalankan, dan perilaku yang sengaja dipilih.

## Stack

| Lapisan | Pilihan | Alasan |
| --- | --- | --- |
| UI | React 19 + TypeScript strict | Sesuai SRS §3.2 |
| Routing | TanStack Router (route tree di `src/router.tsx`) | Routing bertipe; **filter disimpan di `search` URL** sehingga tampilan portofolio/audit dapat dibagikan dan bertahan saat pindah halaman |
| Data | TanStack Query | Cache per kunci, pembatalan otomatis (`AbortSignal`), dan invalidasi dari SSE tanpa menambal state lokal |
| Gaya | Tailwind 4 (`@tailwindcss/vite`, token di `styles.css`) | Token semantik tema terang/gelap mengikuti `prefers-color-scheme` + override manual |
| Komponen aksesibel | Radix Dialog (+ pola shadcn: `cn`, varian tombol) | Fokus terkelola untuk dialog keputusan/kill switch |
| Ikon | lucide-react | Ringan dan konsisten |
| Build | Vite → `apps/web/dist` | Aset ber-hash (`assets/index-<hash>.js`), di-cache `immutable`; `index.html` `no-cache` |

Zod dari `@portfolio/shared` dipakai kembali di klien untuk validasi formulir pendaftaran SaaS
(`CreateSaasRequest`) dan label domain (`STATUS_LABELS`, `APPROVAL_LABELS`, `SUNSET_TAHAP_LABELS`,
…), sehingga UI tidak pernah berbeda dari kontrak API.

## Halaman & pemetaan ke SRS

| Rute | Kebutuhan | Isi |
| --- | --- | --- |
| `/` | FR-7.1, FR-7.6 | Kartu ringkasan, tabel semua unit (Health Score, status, tren MRR, signup, rating, biaya agen, komponen lemah), filter status/periode 7–28–90/pencarian/urutan, aksi cepat per unit (jeda, kill switch unit), tombol siklus harian & daftarkan SaaS |
| `/saas/$id` | FR-7.2 | Health Score + komponen, grafik MRR & rating (SVG tanpa dependensi), tabel metrik harian, evaluasi/transisi status, konfigurasi, konektor, persetujuan unit, aksi pemilik (jeda, konfigurasi, kill switch) |
| `/persetujuan` | FR-7.3, FR-7.6 | Antrean dengan isi permintaan (draf konten, balasan ulasan, PR) dan tombol setujui / minta revisi / tolak; filter status/SaaS Unit/fungsi/jenis |
| `/sunset` | FR-8.5, FR-8.6, FR-7.7 | Usulan menunggu keputusan pemilik (+MFA), progres tahap, maju tahap hingga arsip |
| `/biaya` | FR-7.4 | Biaya agen 30 hari vs anggaran bulanan per unit, per fungsi, antrean & dead-letter |
| `/laporan` | FR-6.3 | Ringkasan Agen Induk, rekomendasi berprioritas, riwayat laporan |
| `/audit` | FR-7.5, FR-7.6 | Setiap tindakan dengan masukan, keluaran, aktor/penyetuju, hash + rantai, filter aktor/tindakan/tanggal/SaaS Unit, paginasi, verifikasi rantai |

**Aksi pemilik (FR-7.7)** semuanya dapat dilakukan dari UI: kill switch global ada di sidebar
(selalu terlihat, satu klik dari portofolio — NFR-8) dan per SaaS di menu tiap baris; keputusan
persetujuan, keputusan sunset (dengan MFA + konfirmasi ketik `SETUJUI`), dan maju tahap sunset
(konfirmasi `ARSIP` untuk tahap final) memakai dialog. Operasi khusus pemilik disembunyikan untuk
operator; server tetap menolak dengan `403` bila dipanggil langsung.

## Alur data

- Token disimpan di `sessionStorage`; EventSource memakai `?access_token=` karena tidak dapat
  mengirim header. Klaim JWT hanya dibaca untuk menyesuaikan tampilan — otorisasi tetap di server.
- SSE `/api/v1/events` membatalkan kunci query yang relevan (`approval.*`, `sunset.*`,
  `health.evaluated`, `killswitch.activated`, …). Indikator **live** di sidebar menampilkan status
  koneksi; EventSource menyambung ulang otomatis (stream server berumur ~55 detik).
- Setiap aksi tulis mengirim `Idempotency-Key` unik (NFR-7) dan menampilkan hasil/galat lewat toast
  serta `aria-live`.

## Keterbatasan yang disengaja

- **Rincian biaya per fungsi/perenderan** belum diekspos API; panel biaya menampilkan total biaya
  agen per unit (dari `agent_run.biaya_usd`) terhadap `config.anggaran_bulanan_usd`, dan menyatakan
  batasan ini secara eksplisit.
- **Riwayat konten/ulasan/PR/insiden** per unit belum punya endpoint khusus. Halaman detail
  menampilkan permintaan persetujuan terkait dan tautan ke log audit; bagian kosong tidak dipalsukan.
- **Filter SaaS Unit pada log audit** diterapkan di klien karena `AuditQuery` server belum memuat
  `saas_id` (kandidat perbaikan API berikutnya).
- **Token MFA** sunset di lokal diterima dengan token berawalan `dev-`; di produksi klaim `mfa`
  dari Cloudflare Access yang dipakai.

## Menjalankan

```bash
npm run build      # Vite → apps/web/dist + bundle Worker
npm start          # dashboard hasil build di :8787
npm run dev:web    # Vite :5173 (HMR), /api & /healthz diproksikan ke :8787
```

Uji: `apps/api/test/assets.test.ts` memverifikasi pengalihan `/dashboard`, header cache aset,
fallback SPA di Worker, dan halaman ringkas saat build belum ada.
