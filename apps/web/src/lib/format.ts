/**
 * Pemetaan label & format. Label domain diambil dari `@portfolio/shared`
 * (konstanta yang sama dengan API) agar UI tidak pernah menyimpang dari kontrak.
 */
import {
  APPROVAL_LABELS,
  FUNGSI_LABELS,
  KOMPONEN_LABELS,
  OTONOMI_LABELS,
  SAAS_STATUSES,
  STATUS_LABELS,
  SUNSET_TAHAP_LABELS,
  type ApprovalJenis,
  type Fungsi,
  type KomponenSkor,
  type Otonomi,
  type SaasStatus,
  type SunsetTahap,
} from '@portfolio/shared';
import type { Peringkat } from './api';

export type Nada = 'ok' | 'warn' | 'bad' | 'info' | 'netral';

// ------------------------------------------------------------------ status SaaS

const NADA_STATUS: Record<SaasStatus, Nada> = {
  aktif: 'ok',
  pengawasan: 'warn',
  intervensi: 'bad',
  percobaan: 'info',
  usulan_sunset: 'bad',
  dalam_sunset: 'warn',
  dihentikan: 'netral',
  diarsipkan: 'netral',
};

export function labelStatus(status: string): string {
  return STATUS_LABELS[status as SaasStatus] ?? status;
}

export function nadaStatus(status: string): Nada {
  return NADA_STATUS[status as SaasStatus] ?? 'netral';
}

/** Status yang boleh dipakai filter portofolio (FR-7.6). */
export const FILTER_STATUS = SAAS_STATUSES.map((s) => ({ nilai: s, label: STATUS_LABELS[s] }));

export function labelPeringkat(peringkat: Peringkat): string {
  switch (peringkat) {
    case 'sehat':
      return 'Sehat';
    case 'pengawasan':
      return 'Perlu pengawasan';
    case 'kritis':
      return 'Kritis';
    default:
      return 'Data tidak cukup';
  }
}

export function nadaPeringkat(peringkat: Peringkat): Nada {
  return peringkat === 'sehat' ? 'ok' : peringkat === 'pengawasan' ? 'warn' : peringkat === 'kritis' ? 'bad' : 'netral';
}

// ------------------------------------------------------------------ fungsi, persetujuan, sunset

export function labelFungsi(fungsi: string | null | undefined): string {
  if (!fungsi) return 'Tanpa fungsi';
  return FUNGSI_LABELS[fungsi as Fungsi] ?? fungsi;
}

export function labelApproval(jenis: string): string {
  return APPROVAL_LABELS[jenis as ApprovalJenis] ?? jenis;
}

/** Kategori persetujuan yang hanya boleh diputuskan pemilik (`app.ts`). */
export const APPROVAL_KHUSUS_PEMILIK = new Set(['sunset', 'merge_pr', 'ubah_harga', 'beli_iklan', 'rc_plan']);

export function labelOtonomi(nilai: string): string {
  return OTONOMI_LABELS[nilai as Otonomi] ?? nilai;
}

export function labelKomponen(key: string): string {
  return KOMPONEN_LABELS[key as KomponenSkor] ?? key;
}

export function tahapSunsetBerikut(tahap: string): SunsetTahap | null {
  const urutan: SunsetTahap[] = ['pengumuman', 'tutup_pendaftaran', 'ekspor', 'penagihan', 'takedown', 'arsip'];
  const idx = urutan.indexOf(tahap as SunsetTahap);
  if (idx < 0 || idx >= urutan.length - 1) return null;
  return urutan[idx + 1] ?? null;
}

export function labelTahapSunset(tahap: string | null | undefined): string {
  if (!tahap) return '—';
  return SUNSET_TAHAP_LABELS[tahap as SunsetTahap] ?? tahap;
}

export const URUTAN_TAHAP_SUNSET: readonly SunsetTahap[] = ['pengumuman', 'tutup_pendaftaran', 'ekspor', 'penagihan', 'takedown', 'arsip'];

// ------------------------------------------------------------------ angka & tanggal

const rupiah = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const rupiahPecahan = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const desimal = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const persen = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });

export function fmtAngka(nilai: number | null | undefined): string {
  if (nilai === null || nilai === undefined || !Number.isFinite(nilai)) return '—';
  return rupiah.format(nilai);
}

export function fmtUang(nilai: number | null | undefined, mataUang = 'USD'): string {
  if (nilai === null || nilai === undefined || !Number.isFinite(nilai)) return '—';
  const kecil = Math.abs(nilai) > 0 && Math.abs(nilai) < 0.01 ? rupiahPecahan.format(nilai) : rupiah.format(nilai);
  return `${mataUang === 'USD' ? '$' : `${mataUang} `}${kecil}`;
}

export function fmtDesimal(nilai: number | null | undefined): string {
  if (nilai === null || nilai === undefined || !Number.isFinite(nilai)) return '—';
  return desimal.format(nilai);
}

export function fmtPersen(nilai: number | null | undefined, opts: { tanda?: boolean } = {}): string {
  if (nilai === null || nilai === undefined || !Number.isFinite(nilai)) return '—';
  const teks = `${persen.format(Math.abs(nilai))}%`;
  if (!opts.tanda) return nilai < 0 ? `-${teks}` : teks;
  if (nilai > 0) return `+${teks}`;
  if (nilai < 0) return `−${teks}`;
  return teks;
}

function keTanggal(nilai: number | string | null | undefined): Date | null {
  if (nilai === null || nilai === undefined || nilai === '') return null;
  const d = typeof nilai === 'number' ? new Date(nilai) : new Date(nilai.length <= 10 ? `${nilai}T00:00:00Z` : nilai);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Tanggal kalender panjang, zona Asia/Jakarta (audience pemilik di Indonesia). */
export function fmtTanggal(nilai: number | string | null | undefined): string {
  const d = keTanggal(nilai);
  if (!d) return '—';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: 'Asia/Jakarta' }).format(d);
}

export function fmtWaktu(nilai: number | string | null | undefined): string {
  const d = keTanggal(nilai);
  if (!d) return '—';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(d);
}

export function fmtTanggalSingkat(nilai: number | string | null | undefined): string {
  const d = keTanggal(nilai);
  if (!d) return '—';
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' }).format(d);
}

/** Sisa waktu relatif, mis. "2 hari 4 jam lagi" / "lewat 3 jam". */
export function fmtSisa(waktuMs: number | null | undefined, sekarang = Date.now()): string {
  if (!waktuMs) return '—';
  const selisih = waktuMs - sekarang;
  const lewat = selisih < 0;
  const total = Math.abs(selisih);
  const menit = Math.floor(total / 60_000);
  if (menit < 1) return lewat ? 'baru saja lewat' : 'kurang dari semenit';
  const hari = Math.floor(menit / 1440);
  const jam = Math.floor((menit % 1440) / 60);
  const sisaMenit = menit % 60;
  const bagian = hari > 0 ? `${hari} hari ${jam} jam` : jam > 0 ? `${jam} jam ${sisaMenit} mnt` : `${sisaMenit} mnt`;
  return lewat ? `lewat ${bagian}` : `${bagian} lagi`;
}

export function isoTanggal(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Rentang preset untuk filter periode (FR-7.6). */
export const PERIODE = [
  { nilai: 7, label: '7 hari' },
  { nilai: 28, label: '28 hari' },
  { nilai: 90, label: '90 hari' },
] as const;

export function slugify(teks: string): string {
  return teks
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
