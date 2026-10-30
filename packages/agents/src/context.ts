/**
 * Konteks runtime agen dan tipe keluaran bersama. Agen menerima konteks ini dari
 * orkestrator (API Workers atau runner Node) sehingga tidak bergantung pada platform.
 */
import type { ContentKanal, DailyMetric, Fungsi, ReviewKategori } from '@portfolio/shared';
import type { ConnectorContext, ConnectorSet } from '@portfolio/connectors';
import type { ModelClient } from './model.ts';
import type { ToolContext } from './tools.ts';

export interface AgentSaas {
  id: string;
  slug: string;
  nama: string;
  status: string;
  config: {
    panduan_merek?: string;
    klaim_terlarang_tambahan: string[];
    tanda_ai: boolean;
    otonomi: Partial<Record<Fungsi, string>>;
    review_kategori_otonom: ReviewKategori[];
    batas_pr_baris: number;
    platform: string[];
  };
}

export interface AgentBudgetInfo {
  batasUsd: number;
  terpakaiUsd: number;
  /** peringatan saat 80% terpakai */
  peringatan: boolean;
}

export interface MemoryRecord {
  ringkasan: string;
  diperbaruiPada: number;
}

export interface AgentRuntime {
  runId: string;
  jobId: string;
  saas: AgentSaas;
  fungsi: Fungsi;
  now: number;
  model: ModelClient;
  connectors: ConnectorSet;
  connectorSecret: (jenis: string) => string | null;
  memory: MemoryRecord | null;
  budget: AgentBudgetInfo | null;
  /** batas langkah tool per run */
  batasLangkah: number;
  /** sisa anggaran dalam USD, null = tidak dibatasi */
  sisaAnggaranUsd: number | null;
  metrics: DailyMetric[];
  tools: ToolContext;
  /** helper untuk teks bebas dari luar (sudah diredaksi) */
  logger: (pesan: string, data?: Record<string, unknown>) => void;
}

export interface AgentOutcome<T> {
  hasil: T;
  ringkasanMemori: string;
  biayaUsd: number;
  tokenMasuk: number;
  tokenKeluar: number;
  model: string;
  langkah: number;
  ditahan: boolean;
}

/** Memo ringkas fitur yang tersedia untuk memfokuskan prompt. */
export interface ProdukFakta {
  nama: string;
  fitur: string[];
  targetPengguna: string;
  pesanUtama: string;
}

export function connectorCtx(rt: AgentRuntime, jenis: string, detail: Record<string, unknown> = {}): ConnectorContext {
  return {
    saasId: rt.saas.id,
    slug: rt.saas.slug,
    secret: rt.connectorSecret(jenis),
    detail,
    now: rt.now,
  };
}

export function faktaProduk(rt: AgentRuntime): ProdukFakta {
  return {
    nama: rt.saas.nama,
    fitur: ['laporan otomatis', 'sinkronisasi perangkat', 'ekspor PDF', 'mode tim'],
    targetPengguna: rt.saas.config.platform.includes('android') ? 'pengguna Android produktif' : 'tim kecil',
    pesanUtama: `${rt.saas.nama} membantu tim bekerja lebih cepat dengan laporan otomatis.`,
  };
}

export const KLAIM_TERLARANG_DEFAULT: string[] = [
  'terbaik di dunia',
  'nomor 1',
  'dijamin 100%',
  'menghasilkan uang',
  'tanpa risiko',
  'testimoni',
  'garansi uang kembali',
  'menyembuhkan',
  'approve pasti',
];

export function daftarKlaimTerlarang(rt: AgentRuntime): string[] {
  return [...KLAIM_TERLARANG_DEFAULT, ...rt.saas.config.klaim_terlarang_tambahan].map((s) => s.toLowerCase());
}

export interface PemeriksaanKlaim {
  lulus: boolean;
  pelanggaran: string[];
}

/** Periksa teks konten terhadap klaim terlarang (FR-2.7). */
export function periksaKlaim(teks: string, terlarang: string[]): PemeriksaanKlaim {
  const lower = teks.toLowerCase();
  const pelanggaran = terlarang.filter((k) => lower.includes(k));
  return { lulus: pelanggaran.length === 0, pelanggaran };
}

export type { ContentKanal };
