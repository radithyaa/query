/**
 * Parameter URL untuk filter (FR-7.6: periode, SaaS Unit, fungsi agen).
 * Menyimpan filter di URL membuat tampilan dapat dibagikan dan bertahan saat
 * berpindah halaman (mis. portofolio → detail → log audit unit yang sama).
 *
 * Tipe validasinya ada di `router.tsx` (Zod per rute); berkas ini hanya berisi
 * helper bersama.
 */
import type { ApprovalStatus } from './api';

export type Periode = 7 | 28 | 90;

export interface SearchPortofolio {
  periode?: Periode;
  status?: string;
  /** pencarian nama/slug */
  q?: string;
}

export interface SearchAudit {
  saas?: string;
  aktor?: string;
  tindakan?: string;
  dari?: string;
  sampai?: string;
  offset?: number;
}

export interface SearchPersetujuan {
  saas?: string;
  fungsi?: string;
  jenis?: string;
  status?: ApprovalStatus;
}

export interface SearchUnit {
  periode?: Periode;
}

export function periodeValid(nilai: unknown): Periode {
  return nilai === 7 || nilai === 90 ? nilai : 28;
}

export function teksValid(nilai: unknown): string | undefined {
  return typeof nilai === 'string' && nilai.trim() !== '' ? nilai : undefined;
}

/** Rentang YYYY-MM-DD untuk filter tanggal cepat (berbasis UTC, sama dengan server). */
export function rentangHari(hari: number, sekarang = Date.now()): { dari: string; sampai: string } {
  const akhir = new Date(sekarang);
  const awal = new Date(sekarang - (hari - 1) * 86_400_000);
  return { dari: awal.toISOString().slice(0, 10), sampai: akhir.toISOString().slice(0, 10) };
}
