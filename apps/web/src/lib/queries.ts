/**
 * Query bersama (TanStack Query) dan hook turunan untuk filter lintas halaman.
 *
 * Kunci query dipusatkan di sini karena SSE (`usePeristiwaLive`) membatalkan
 * kunci yang sama saat event masuk — jangan membuat kunci inline di komponen.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, type AuditItem } from './api';

export const KUNCI = {
  summary: (periode: number) => ['summary', periode] as const,
  units: () => ['unit', 'ringkas'] as const,
  unit: (id: string) => ['unit', id] as const,
  status: (id: string) => ['status', id] as const,
  metrik: (id: string, periode: number) => ['metrik', id, periode] as const,
  approvals: (status?: string) => (status ? (['approvals', status] as const) : (['approvals'] as const)),
  persetujuanUnit: (saasId: string) => ['approvals', 'saas', saasId] as const,
  sunset: () => ['sunset'] as const,
  killswitch: () => ['killswitch'] as const,
  ops: () => ['ops'] as const,
  laporanTerbaru: () => ['laporan', 'terbaru'] as const,
  laporan: () => ['laporan', 'daftar'] as const,
  audit: (offset: number) => ['audit', 'daftar', offset] as const,
  auditVerify: () => ['audit', 'verify'] as const,
};

/** Nama SaaS untuk kolom `saasId` yang dikirim API dalam bentuk id. */
export function useNamaUnit(): (id: string | null | undefined) => { nama: string; slug: string | null } {
  const { data } = useQuery({ queryKey: KUNCI.units(), queryFn: ({ signal }) => api.units(signal), staleTime: 60_000 });
  return useMemo(() => {
    const peta = new Map((data?.data ?? []).map((u) => [u.id, { nama: u.nama, slug: u.slug }]));
    return (id) => (id ? (peta.get(id) ?? { nama: `${id.slice(0, 8)}…`, slug: null }) : { nama: '—', slug: null });
  }, [data]);
}

/**
 * Log audit dengan filter aktor/tindakan/tanggal di server dan filter SaaS Unit
 * di klien: `GET /api/v1/audit` menerima `saas_id` pada repositori tetapi belum
 * meneruskannya di `AuditQuery`, sehingga filternya diterapkan pada 100 baris
 * halaman aktif.
 */
export function useAudit(filter: { aktor: string; tindakan: string; dari: string; sampai: string; saasId: string; offset: number }) {
  const query = useQuery({
    queryKey: KUNCI.audit(filter.offset),
    queryFn: ({ signal }) =>
      api.audit({
        limit: 100,
        offset: filter.offset,
        ...(filter.aktor ? { aktor: filter.aktor } : {}),
        ...(filter.tindakan ? { tindakan: filter.tindakan } : {}),
        ...(filter.dari ? { dari: filter.dari } : {}),
        ...(filter.sampai ? { sampai: filter.sampai } : {}),
        signal,
      }),
    placeholderData: keepPreviousData,
  });

  const rows: AuditItem[] = useMemo(() => {
    const daftar = query.data?.data ?? [];
    return filter.saasId ? daftar.filter((r) => r.saas_id === filter.saasId) : daftar;
  }, [query.data, filter.saasId]);

  return { ...query, rows };
}

export function useSemuaUnit() {
  return useQuery({ queryKey: KUNCI.units(), queryFn: ({ signal }) => api.units(signal), staleTime: 60_000 });
}
