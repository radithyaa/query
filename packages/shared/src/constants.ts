/**
 * Konstanta domain bersama: status SaaS Unit, fungsi agen, tingkat otonomi,
 * jenis tindakan, dan tabel aturan transisi (FR-8).
 */

export const SAAS_STATUSES = [
  'aktif',
  'pengawasan',
  'intervensi',
  'percobaan',
  'usulan_sunset',
  'dalam_sunset',
  'dihentikan',
  'diarsipkan',
] as const;
export type SaasStatus = (typeof SAAS_STATUSES)[number];

export const STATUS_LABELS: Record<SaasStatus, string> = {
  aktif: 'Aktif',
  pengawasan: 'Pengawasan',
  intervensi: 'Intervensi',
  percobaan: 'Masa Percobaan',
  usulan_sunset: 'Usulan Sunset',
  dalam_sunset: 'Dalam Sunset',
  dihentikan: 'Dihentikan',
  diarsipkan: 'Diarsipkan',
};

export const FUNGSI = ['promosi', 'review', 'kode', 'support', 'parent'] as const;
export type Fungsi = (typeof FUNGSI)[number];

export const FUNGSI_LABELS: Record<Fungsi, string> = {
  promosi: 'Promosi',
  review: 'Review',
  kode: 'Engineering',
  support: 'Support',
  parent: 'Agen Induk',
};

/** Fungsi yang dijalankan per SaaS Unit pada siklus harian; `parent` dijalankan sekali untuk portofolio. */
export const UNIT_FUNGSI = ['review', 'support', 'promosi', 'kode'] as const satisfies readonly Fungsi[];

export const OTONOMI = ['draf', 'persetujuan', 'otonom'] as const;
export type Otonomi = (typeof OTONOMI)[number];

export const OTONOMI_LABELS: Record<Otonomi, string> = {
  draf: 'Draf saja',
  persetujuan: 'Persetujuan',
  otonom: 'Otonom terbatas',
};

/** Jenis job yang dapat diminta penjadwal (kunci idempotensi `saas:fungsi:jenis:tanggal`). */
export const JOB_JENIS = [
  'review_harian',
  'support_harian',
  'promosi_harian',
  'promosi_mingguan',
  'kode_harian',
  'triage_error',
  'parent_harian',
  'parent_mingguan',
  'health_evaluasi',
  'sunset_tahap',
] as const;
export type JobJenis = (typeof JOB_JENIS)[number];

export const JOB_STATUS = ['queued', 'running', 'awaiting_approval', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

/** Jenis tindakan tool tulis; semua melewati policy gateway. */
export const TINDAKAN = [
  'terbit_post',
  'jadwalkan_post',
  'balas_ulasan',
  'buat_issue',
  'buka_pr',
  'merge_pr',
  'deploy',
  'ubah_harga',
  'kirim_email_massal',
  'beli_iklan',
  'sunset',
  'jalankan_render',
  'simpan_konten',
] as const;
export type Tindakan = (typeof TINDAKAN)[number];

/**
 * Tindakan yang SELALU butuh persetujuan manusia (FR-9.2), apa pun tingkat otonominya.
 */
export const SELALU_HITL: ReadonlySet<Tindakan> = new Set<Tindakan>([
  'merge_pr',
  'deploy',
  'ubah_harga',
  'kirim_email_massal',
  'sunset',
  'beli_iklan',
]);

/** Jenis persetujuan yang dikenal tabel `approval`. */
export const APPROVAL_JENIS = [
  'merge_pr',
  'terbit_post',
  'balas_ulasan',
  'sunset',
  'ubah_harga',
  'kirim_email_massal',
  'beli_iklan',
  'rc_plan',
  'buat_issue',
  'render_video',
  'lainnya',
] as const;
export type ApprovalJenis = (typeof APPROVAL_JENIS)[number];

export const APPROVAL_STATUS = ['menunggu', 'disetujui', 'ditolak', 'revisi', 'kedaluwarsa'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number];

export const APPROVAL_LABELS: Record<ApprovalJenis, string> = {
  merge_pr: 'Merge Pull Request',
  terbit_post: 'Terbit Konten',
  balas_ulasan: 'Balas Ulasan',
  sunset: 'Usulan Sunset',
  ubah_harga: 'Perubahan Harga',
  kirim_email_massal: 'Kirim Email Massal',
  beli_iklan: 'Pembelian Iklan',
  rc_plan: 'Rencana Pemulihan',
  buat_issue: 'Buat Issue GitHub',
  render_video: 'Render Video',
  lainnya: 'Lainnya',
};

export const REVIEW_KATEGORI = ['bug', 'permintaan_fitur', 'masalah_performa', 'keluhan_harga', 'pujian', 'spam'] as const;
export type ReviewKategori = (typeof REVIEW_KATEGORI)[number];

export const CONTENT_KANAL = ['instagram', 'tiktok', 'youtube_shorts', 'email', 'blog', 'store_listing', 'ads'] as const;
export type ContentKanal = (typeof CONTENT_KANAL)[number];

export const CONTENT_STATUS = ['draf', 'menunggu', 'disetujui', 'dijadwalkan', 'terbit', 'ditolak', 'revisi'] as const;
export type ContentStatus = (typeof CONTENT_STATUS)[number];

export const PR_STATUS = ['draf', 'menunggu_review', 'disetujui', 'ditolak', 'merged', 'ditutup'] as const;
export type PrStatus = (typeof PR_STATUS)[number];

export const SUNSET_TAHAP = [
  'diusulkan',
  'pengumuman',
  'tutup_pendaftaran',
  'ekspor',
  'penagihan',
  'takedown',
  'arsip',
] as const;
export type SunsetTahap = (typeof SUNSET_TAHAP)[number];

export const SUNSET_TAHAP_LABELS: Record<SunsetTahap, string> = {
  diusulkan: 'Diusulkan',
  pengumuman: 'Pengumuman ke pelanggan',
  tutup_pendaftaran: 'Tutup pendaftaran baru',
  ekspor: 'Tawarkan ekspor data',
  penagihan: 'Selesaikan penagihan & refund',
  takedown: 'Cabut dari toko aplikasi',
  arsip: 'Arsipkan repo & data',
};

export const KONEKTOR_JENIS = ['github', 'play', 'instagram', 'sentry', 'billing', 'analytics'] as const;
export type KonektorJenis = (typeof KONEKTOR_JENIS)[number];

export const BUDGET_JENIS = ['token', 'render', 'ads'] as const;
export type BudgetJenis = (typeof BUDGET_JENIS)[number];

export const ROLE = ['owner', 'operator', 'service', 'connector'] as const;
export type Role = (typeof ROLE)[number];

/**
 * Tabel aturan transisi FR-8 (nilai awal yang dapat diubah lewat konfigurasi).
 * Threshold/batas jumlah evaluasi diambil dari config SaaS Unit bila ada.
 */
export interface TransitionThresholds {
  pengawasan: number;
  intervensi: number;
  /** jumlah evaluasi berturut-turut di bawah ambang sebelum turun status */
  berturut: number;
  /** jumlah evaluasi berturut-turut mencapai kriteria bangkit sebelum pulih */
  pemulihanBerturut: number;
  /** lama jendela evaluasi (hari) */
  jendelaHari: number;
  /** lama masa percobaan (hari) bila pemilik tidak menetapkan */
  masaPercobaanHari: number;
  /** berapa lama konektor utama boleh mati sebelum evaluasi ditahan (jam) */
  batasKonektorMatiJam: number;
}

export const DEFAULT_TRANSITION: TransitionThresholds = {
  pengawasan: 70,
  intervensi: 55,
  berturut: 2,
  pemulihanBerturut: 2,
  jendelaHari: 28,
  masaPercobaanHari: 90,
  batasKonektorMatiJam: 48,
};

/** Bobot awal komponen Health Score (jumlah 100). */
export const DEFAULT_BOBOT = {
  pendapatan: 25,
  retensi: 20,
  pengguna: 15,
  kepuasan: 15,
  stabilitas: 15,
  biaya: 10,
} as const;

export type KomponenSkor = keyof typeof DEFAULT_BOBOT;
export const KOMPONEN = Object.keys(DEFAULT_BOBOT) as KomponenSkor[];

export const KOMPONEN_LABELS: Record<KomponenSkor, string> = {
  pendapatan: 'Pertumbuhan pendapatan',
  retensi: 'Retensi',
  pengguna: 'Pertumbuhan pengguna',
  kepuasan: 'Kepuasan',
  stabilitas: 'Stabilitas',
  biaya: 'Efisiensi biaya',
};

/**
 * Nilai min/target pembanding per komponen. Skor komponen dinormalkan ke 0..100
 * terhadap (min, target); angka di bawah ilustratif dan dapat diubah per SaaS Unit.
 */
export interface SkalaKomponen {
  min: number;
  target: number;
}

export const DEFAULT_SKALA: Record<KomponenSkor, SkalaKomponen> = {
  // pertumbuhan MRR 28 hari dalam persen
  pendapatan: { min: -10, target: 15 },
  // churn bulanan persen (semakin rendah semakin baik)
  retensi: { min: 10, target: 2 },
  // persentase signup baru terhadap MAU dalam 28 hari
  pengguna: { min: 1, target: 12 },
  // rating toko aplikasi dikurangi proporsi ulasan negatif
  kepuasan: { min: 3.0, target: 4.6 },
  // uptime persen dikurangi error rate
  stabilitas: { min: 97, target: 99.9 },
  // rasio biaya terhadap pendapatan dalam persen (semakin rendah semakin baik)
  biaya: { min: 60, target: 10 },
};

/** Komponen yang arah baiknya menurun. */
export const KOMPONEN_INVERS: ReadonlySet<KomponenSkor> = new Set<KomponenSkor>(['retensi', 'biaya']);

export const EVENT_NAMES = [
  'metric.ingested',
  'metric.rejected',
  'agent.job.requested',
  'agent.job.failed',
  'agent.run.completed',
  'content.draft.created',
  'review.theme.detected',
  'pr.opened',
  'approval.requested',
  'approval.resolved',
  'health.evaluated',
  'sunset.proposed',
  'sunset.stage.changed',
  'budget.exceeded',
  'killswitch.activated',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const METRIC_SKEMA_VERSI = 1;

/** Versi prompt setiap agen (dicatat di `agent_run.versi_prompt`, §5.8). */
export const PROMPT_VERSI: Record<Fungsi, string> = {
  promosi: 'promosi@1',
  review: 'review@1',
  kode: 'kode@1',
  support: 'support@1',
  parent: 'parent@1',
};

/** Batas default satu job agen (`agent_job.batas`). */
export interface JobBatas {
  max_langkah: number;
  max_token: number;
  timeout_ms: number;
}

export const DEFAULT_JOB_BATAS: JobBatas = { max_langkah: 12, max_token: 60_000, timeout_ms: 120_000 };

/** Batas nomor token layanan per job (§7.2): 1 jam. */
export const SERVICE_TOKEN_TTL_MAKS_DETIK = 3600;

/** Batas kedaluwarsa default permintaan persetujuan (ms). */
export const DEFAULT_APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

export const IDEM_KEY_HEADER = 'Idempotency-Key';
export const RUN_ID_HEADER = 'x-run-id';
