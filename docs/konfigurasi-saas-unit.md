# Konfigurasi SaaS Unit

Satu SaaS Unit adalah satu baris `saas_unit`; seluruh perilakunya diatur oleh kolom `config`
(JSON, divalidasi `SaasConfig` di `packages/shared/src/schemas.ts`). Menambah SaaS Unit baru
tidak memerlukan perubahan kode (NFR-10).

## 1. Mendaftarkan SaaS Unit

```bash
curl -X POST localhost:8787/api/v1/saas \
  -H "authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: daftar-contoh-saas-001' \
  -H 'content-type: application/json' \
  -d '{
    "slug": "contoh-saas",
    "nama": "Contoh SaaS",
    "platform": ["android", "web"],
    "repo": "org/contoh-saas",
    "akun_toko": "com.contoh.saas",
    "akun_sosial": "instagram/contoh",
    "config": {
      "otonomi": { "promosi": "persetujuan", "review": "draf", "kode": "persetujuan", "support": "draf" },
      "anggaran_bulanan_usd": { "promosi": 40, "review": 15, "kode": 60, "support": 10, "render": 25 },
      "kriteria_bangkit": {
        "jendela_evaluasi_hari": 28,
        "masa_percobaan_hari": 90,
        "syarat": [
          { "metrik": "pertumbuhan_mrr_persen", "minimal": 10 },
          { "metrik": "rating_rata2", "minimal": 4.0 }
        ]
      },
      "bobot_skor": { "pendapatan": 25, "retensi": 20, "pengguna": 15, "kepuasan": 15, "stabilitas": 15, "biaya": 10 },
      "ambang": { "pengawasan": 70, "intervensi": 55, "berturut": 2, "pemulihan_berturut": 2, "batas_konektor_mati_jam": 48 },
      "pengecualian_sunset": false
    },
    "konektor": [
      { "jenis": "billing", "secret_ref": "secret://billing/contoh-saas", "utama": true },
      { "jenis": "play", "secret_ref": "secret://play/contoh-saas", "utama": true },
      { "jenis": "github", "secret_ref": "secret://github/contoh-saas", "detail": { "repo": "org/contoh-saas" } }
    ]
  }'
```

`secret_ref` adalah **nama** secret, bukan nilainya (NFR-2). Endpoint tulis memerlukan header
`Idempotency-Key` (≥ 8 karakter).

## 2. Tingkat otonomi (FR-9.1)

| Nilai | Arti |
| --- | --- |
| `draf` | Agen hanya menyiapkan; setiap tool tulis menjadi permintaan persetujuan |
| `persetujuan` | Sama, tetapi dipakai sebagai tanda agen sudah "siap bertindak setelah disetujui" |
| `otonom` | Tindakan dalam daftar terbatas (`balas_ulasan`, `buat_issue`, `buka_pr`, `terbit_post`, …) dijalankan sendiri; tindakan HITL wajib tetap minta persetujuan |

Tindakan yang **selalu** butuh manusia (`SELALU_HITL`): `merge_pr`, `deploy`, `ubah_harga`,
`kirim_email_massal`, `sunset`, `beli_iklan`.

## 3. Anggaran (FR-10)

`anggaran_bulanan_usd` per fungsi dalam USD; periode `YYYY-MM`. Baris `agent_budget` dibuat saat
job berjalan. Peringatan pada 80% masuk ke `notification_outbox`; pada 100% event
`budget.exceeded` dan gateway menolak tindakan tulis fungsi tersebut.

## 4. Kriteria bangkit & ambang (FR-8.2, FR-8.7)

- `kriteria_bangkit.syarat` dievaluasi terhadap metrik jendela evaluasi; semua syarat harus lulus.
- Metrik yang didukung: `pertumbuhan_mrr_persen`, `rating_rata2`, `churn_bulanan_persen`,
  `mrr`, `aktivasi_persen`.
- `ambang` mengubah tabel transisi tanpa mengubah kode. `berturut` = jumlah evaluasi berturut-turut
  di bawah ambang sebelum turun status; `pemulihan_berturut` untuk pemulihan.
- `tenggat_iso` ditulis otomatis saat rencana pemulihan disetujui atau sunset ditolak (internal).
- Lebih dari sepertiga bobot metrik hilang → evaluasi "data tidak cukup" dan status tidak turun.

## 5. Konten & merek

| Field | Fungsi |
| --- | --- |
| `panduan_merek` | Teks bebas yang masuk prompt agen Promosi/Review |
| `klaim_terlarang_tambahan` | Frasa terlarang di luar daftar bawaan (FR-2.7) |
| `tanda_ai` | Menambahkan penanda konten AI pada draf (NFR-13) |
| `review_kategori_otonom` | Kategori ulasan yang boleh dibalas otomatis pada tingkat `otonom` |
| `batas_pr_baris` | Batas ukuran perubahan PR Agen Kode |
| `fungsi_aktif` | Fungsi yang dijadwalkan pada siklus harian |

## 6. Konektor

Jenis: `github`, `play`, `instagram`, `sentry`, `billing`, `analytics`. Konektor `utama: true`
dipakai Health engine: bila semuanya mati lebih dari `batas_konektor_mati_jam`, evaluasi ditahan
(agar gangguan data tidak menjadi usulan sunset). Mode lokal/staging memakai mock deterministik
(`MOCK_CONNECTORS=true`).
