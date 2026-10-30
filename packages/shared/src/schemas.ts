import { z } from 'zod';
import {
  APPROVAL_JENIS,
  APPROVAL_STATUS,
  BUDGET_JENIS,
  CONTENT_KANAL,
  CONTENT_STATUS,
  FUNGSI,
  KONEKTOR_JENIS,
  METRIC_SKEMA_VERSI,
  OTONOMI,
  PR_STATUS,
  REVIEW_KATEGORI,
  SAAS_STATUSES,
  SUNSET_TAHAP,
  TINDAKAN,
} from './constants.ts';

const nonNeg = z.number().finite().nonnegative();
const percent = z.number().finite().min(0).max(100);
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

/**
 * Blok metrik opsional: boleh tidak ada, boleh `null`, dan setiap field di dalamnya
 * boleh tidak tersedia — metrik yang belum tersedia dikirim sebagai `null` atau
 * dihilangkan sama sekali (§6.2, FR-6.1).
 */
const blok = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .nullable()
    .optional();

/** Konfigurasi satu SaaS Unit; padanan §11.1 dengan nilai default yang masuk akal. */
export const OtonomiConfig = z.partialRecord(z.enum(FUNGSI), z.enum(OTONOMI));

export const BobotSkor = z.object({
  pendapatan: z.number().finite().nonnegative(),
  retensi: z.number().finite().nonnegative(),
  pengguna: z.number().finite().nonnegative(),
  kepuasan: z.number().finite().nonnegative(),
  stabilitas: z.number().finite().nonnegative(),
  biaya: z.number().finite().nonnegative(),
});

export const SkalaSkor = z.object({
  pendapatan: z.object({ min: z.number().finite(), target: z.number().finite() }),
  retensi: z.object({ min: z.number().finite(), target: z.number().finite() }),
  pengguna: z.object({ min: z.number().finite(), target: z.number().finite() }),
  kepuasan: z.object({ min: z.number().finite(), target: z.number().finite() }),
  stabilitas: z.object({ min: z.number().finite(), target: z.number().finite() }),
  biaya: z.object({ min: z.number().finite(), target: z.number().finite() }),
});

export const KriteriaBangkit = z.object({
  jendela_evaluasi_hari: z.number().int().positive().max(365).default(28),
  masa_percobaan_hari: z.number().int().positive().max(365).default(90),
  syarat: z
    .array(
      z.object({
        metrik: z.enum(['pertumbuhan_mrr_persen', 'rating_rata2', 'churn_bulanan_persen', 'mrr', 'aktivasi_persen']),
        minimal: z.number().finite().optional(),
        maksimal: z.number().finite().optional(),
      }),
    )
    .default([]),
});

export const AmbangConfig = z.object({
  pengawasan: z.number().finite().min(0).max(100).default(70),
  intervensi: z.number().finite().min(0).max(100).default(55),
  berturut: z.number().int().min(1).max(12).default(2),
  pemulihan_berturut: z.number().int().min(1).max(12).default(2),
  batas_konektor_mati_jam: z.number().finite().positive().default(48),
});

export const SaasConfig = z.object({
  platform: z.array(z.string().min(1)).default([]),
  otonomi: OtonomiConfig.default({}),
  anggaran_bulanan_usd: z.record(z.string(), z.number().finite().nonnegative()).default({}),
  kriteria_bangkit: KriteriaBangkit.default({ jendela_evaluasi_hari: 28, masa_percobaan_hari: 90, syarat: [] }),
  bobot_skor: BobotSkor.partial().default({}),
  skala_skor: SkalaSkor.partial().default({}),
  ambang: AmbangConfig.partial().default({}),
  pengecualian_sunset: z.boolean().default(false),
  /** Fungsi yang boleh berjalan otomatis pada siklus harian */
  fungsi_aktif: z.array(z.enum(FUNGSI)).default(['review', 'support', 'promosi', 'kode']),
  /** Kategori ulasan yang boleh dibalas otomatis pada tingkat otonom */
  review_kategori_otonom: z.array(z.enum(REVIEW_KATEGORI)).default(['pujian']),
  /** Batas ukuran PR agen kode */
  batas_pr_baris: z.number().int().positive().default(400),
  /** Laba/rugi kotor minimum untuk aksi berisiko (tidak dipakai, cadangan) */
  sektor: z.string().optional(),
  /** Penandaan konten AI (NFR-13) */
  tanda_ai: z.boolean().default(true),
  /** Klaim terlarang bertambah per merek */
  klaim_terlarang_tambahan: z.array(z.string().min(2)).default([]),
  /** Panduan merek bebas untuk prompt */
  panduan_merek: z.string().max(4000).optional(),
});

export type SaasConfigInput = z.input<typeof SaasConfig>;
export type SaasConfigResolved = z.output<typeof SaasConfig>;

/** Skema metrik harian §6.2 — setiap blok boleh tidak tersedia (`null`) atau dihilangkan. */
export const DailyMetric = z.object({
  skema_versi: z.literal(METRIC_SKEMA_VERSI),
  tanggal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format YYYY-MM-DD'),
  mata_uang: z.enum(['IDR', 'USD', 'EUR', 'SGD']).default('USD'),
  bisnis: blok({
    mrr: nullable(nonNeg),
    pelanggan_aktif: nullable(z.number().int().nonnegative()),
    signup_baru: nullable(z.number().int().nonnegative()),
    churn_bulanan_persen: nullable(percent),
    
  }),
  produk: blok({
    dau: nullable(z.number().int().nonnegative()),
    mau: nullable(z.number().int().nonnegative()),
    aktivasi_persen: nullable(percent),
    
  }),
  toko_aplikasi: blok({
    rating_rata2: nullable(z.number().finite().min(0).max(5)),
    ulasan_baru: nullable(z.number().int().nonnegative()),
    ulasan_negatif: nullable(z.number().int().nonnegative()),
    
  }),
  stabilitas: blok({
    error_rate_persen: nullable(percent),
    uptime_persen: nullable(percent),
    bug_terbuka: nullable(z.number().int().nonnegative()),
    
  }),
  biaya: blok({
    infra: nullable(nonNeg),
    agen: nullable(nonNeg),
    
  }),
});

export type DailyMetric = z.infer<typeof DailyMetric>;

export const KonektorInput = z.object({
  jenis: z.enum(KONEKTOR_JENIS),
  secret_ref: z.string().min(1).max(200),
  detail: z.record(z.string(), z.unknown()).default({}),
  /** konektor data utama dipakai untuk menahan evaluasi saat mati (FR-8) */
  utama: z.boolean().default(false),
});

export const CreateSaasRequest = z.object({
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug harus huruf kecil, angka, dan tanda hubung'),
  nama: z.string().min(2).max(160),
  status: z.enum(SAAS_STATUSES).default('aktif'),
  platform: z.array(z.string().min(1)).default([]),
  repo: z.string().max(200).optional(),
  akun_toko: z.string().max(200).optional(),
  akun_sosial: z.string().max(200).optional(),
  config: SaasConfig.partial().default({}),
  konektor: z.array(KonektorInput).default([]),
});

export type CreateSaasRequest = z.infer<typeof CreateSaasRequest>;

export const UpdateConfigRequest = z.object({
  config: SaasConfig.partial(),
});

export const PingRequest = z.object({ pesan: z.string().max(500).default('ping') });

export const ApprovalDecisionRequest = z.object({
  keputusan: z.enum(['setujui', 'tolak', 'revisi']),
  catatan: z.string().max(2000).optional(),
});

export const SunsetDecisionRequest = z.object({
  keputusan: z.enum(['setujui', 'tolak', 'pengecualian']),
  catatan: z.string().max(2000).optional(),
  /** tenggat baru untuk keputusan tolak/pengecualian */
  tenggat_baru: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** wajib: autentikasi ulang MFA (FR-7.2, §7.2) */
  mfa_token: z.string().min(4).max(64),
});

export const KillSwitchRequest = z.object({
  aktif: z.boolean(),
  saas_id: z.string().min(1).optional(),
  alasan: z.string().min(3).max(500),
});

export const GatewayCheckRequest = z.object({
  saasId: z.string().min(1),
  fungsi: z.enum(FUNGSI),
  tindakan: z.enum(TINDAKAN),
  idemKey: z.string().min(8).max(200),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** perkiraan biaya tindakan dalam USD (render, iklan) */
  biaya_perkiraan_usd: z.number().finite().nonnegative().optional(),
  jenis_persetujuan: z.enum(APPROVAL_JENIS).optional(),
  ringkasan_dampak: z.string().max(2000).optional(),
  run_id: z.string().max(80).optional(),
  job_id: z.string().max(80).optional(),
});

export type GatewayCheckRequest = z.infer<typeof GatewayCheckRequest>;

export const GatewayDecision = z.object({
  keputusan: z.enum(['izinkan', 'tolak', 'perlu_persetujuan']),
  alasan: z.string(),
  approval_id: z.string().nullable().default(null),
  sisa_anggaran_usd: z.number().finite().nullable().default(null),
  aturan: z.array(z.string()).default([]),
});

export type GatewayDecision = z.infer<typeof GatewayDecision>;

export const ServiceTokenRequest = z.object({
  saas_id: z.string().min(1),
  fungsi: z.enum(FUNGSI),
  job_id: z.string().min(1).max(80).optional(),
  ttl_detik: z.number().int().min(60).max(3600).default(900),
});

export const IngestRequest = DailyMetric;

export const ListQuery = z.object({
  status: z.enum(SAAS_STATUSES).optional(),
  fungsi: z.enum(FUNGSI).optional(),
  periode: z.coerce.number().int().min(1).max(365).default(28),
  saas_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const AuditQuery = z.object({
  saas_id: z.string().optional(),
  aktor: z.string().optional(),
  tindakan: z.string().optional(),
  dari: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format YYYY-MM-DD').optional(),
  sampai: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format YYYY-MM-DD').optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export const ApprovalsQuery = z.object({
  status: z.enum(APPROVAL_STATUS).default('menunggu'),
  saas_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PrRefInput = z.object({
  saas_id: z.string(),
  nomor: z.number().int().positive(),
  repo: z.string(),
  judul: z.string().max(300),
  url: z.string().max(500).optional(),
  issue_asal: z.string().max(200).optional(),
  status: z.enum(PR_STATUS).default('menunggu_review'),
  ci_lulus: z.boolean().nullable().default(null),
  ringkasan: z.string().max(4000).optional(),
});

export const ContentInput = z.object({
  kanal: z.enum(CONTENT_KANAL),
  judul: z.string().max(300),
  body: z.string().max(20000),
  hashtag: z.array(z.string().max(60)).default([]),
  alt_text: z.string().max(1000).optional(),
  jadwal: z.string().max(64).optional(),
  status: z.enum(CONTENT_STATUS).default('draf'),
  skrip_video: z.record(z.string(), z.unknown()).optional(),
  pemeriksaan_klaim: z.record(z.string(), z.unknown()).optional(),
});

export { BUDGET_JENIS, SUNSET_TAHAP };
