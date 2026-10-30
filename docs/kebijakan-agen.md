# Kebijakan agen

Ringkasan aturan yang ditegakkan **oleh kode**, bukan hanya oleh prompt. Prompt tetap memuat
kerangka §11.2 (`KEBIJAKAN_AGEN` di `packages/agents/src/policy.ts`) agar model patuh, tetapi
kepatuhan diuji ulang oleh gateway, matriks izin, dan golden set.

## 1. Matriks izin (SRS §3.6)

Tool yang tersedia per fungsi (`toolsFor` di `packages/agents/src/tools.ts`):

| Tool | Promosi | Review | Kode | Support | Parent |
| --- | :-: | :-: | :-: | :-: | :-: |
| `terbit_post`, `jadwalkan_post`, `simpan_konten`, `jalankan_render` | ✓ | | | | |
| `balas_ulasan` | | ✓ | | | |
| `buat_issue` | | ✓ | ✓ | | |
| `buka_pr` | | | ✓ | | |
| `merge_pr`, `deploy` | | | ✓ (selalu HITL) | | |
| `ubah_harga`, `sunset` | | | | | ✓ (selalu HITL) |
| `kirim_email_massal`, `beli_iklan` | ✓ (selalu HITL) | | | | |

Fungsi tanpa tool tulis (Support) tetap tidak dapat menulis apa pun: loop hanya menjalankan tool
yang ada di daftar, dan tool di luar daftar dicatat sebagai `tool_tidak_diizinkan`.

## 2. Teks luar adalah data (NFR-4)

- Setiap teks dari luar (ulasan, issue, tiket, halaman) dibungkus `bungkusDataLuar()` dengan
  label sumber dan penanda `sumber="pengguna_tidak_tepercaya"`; teks dipotong agar tidak
  membanjiri konteks.
- `deteksiInjeksi()` menandai pola instruksi (abaikan instruksi sebelumnya, `<system>`,
  "jalankan perintah", "bocorkan secret", dst). Teks bertanda tetap dikirim tetapi diberi
  peringatan eksplisit untuk diperlakukan sebagai opini pengguna.
- Ulasan bertanda injection diklasifikasikan `spam` oleh aturan, dan tiket bertanda injection
  dieskalasi ke manusia, bukan dijawab.

## 3. Rantai tulis

1. Model mengusulkan satu tool per langkah (JSON `{pemikiran, tool, argumen, selesai, keluaran}`).
2. Tool membentuk permintaan `GatewayCheckRequest` (`idemKey` dari `run_id` + tindakan + panjang argumen).
3. Gateway memeriksa kill switch → status → izin → jeda → rate limit → anggaran → HITL → otonomi.
4. `izinkan` → efek dijalankan (deterministik + idempoten); `perlu_persetujuan` → baris
   `approval` + event `approval.requested`; `tolak` → observasi dikembalikan ke model.
5. Setiap panggilan gateway diaudit (`gateway.<tindakan>`).

## 4. Batas kerja

- `max_langkah`, `max_token`, `waktu_maks_ms`, dan sisa anggaran diperiksa tiap langkah; bila
  habis, loop berhenti dan memakai **fallback deterministik** agen (aturan kata kunci, KB,
  kalender) sehingga keluaran tetap berskema dan dapat diaudit.
- Kegagalan model atau keluaran tidak valid tidak menggagalkan job; fallback dipakai dan
  dicatat di log (`agent.fallback`).

## 5. Klaim & keluhan

- Agen Promosi memeriksa semua kalender terhadap daftar klaim terlarang (bawaan + per merek);
  item gagal tidak boleh terbit.
- Agen Support tidak boleh menjanjikan refund, harga, atau fitur; jawaban yang memuat janji
  otomatis diganti dengan eskalasi ke manusia (`periksaLaranganJanji`).

## 6. Golden set & rilis

Golden set (`packages/agents/src/golden.ts`, diuji di `packages/agents/test/golden.test.ts`)
mencakup klasifikasi ulasan berlabel, contoh konten dengan klaim terlarang, uji prompt injection,
dan triage issue. Setiap perubahan prompt, tool, atau model diperlakukan sebagai rilis: naikkan
`PROMPT_VERSI` (`packages/shared/src/constants.ts`) — nilainya dicatat di `agent_run.versi_prompt`.
