/**
 * Laporan Agen Induk (FR-6.3, §3.5): ringkasan harian portofolio beserta
 * rekomendasi, dan riwayat laporan sebelumnya.
 */
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, FileText } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtWaktu } from '../lib/format';
import { KUNCI } from '../lib/queries';
import { Badge, Card, CardHeader, cn, Galat, Kosong, Memuat, Select } from '../components/ui';

interface Rekomendasi {
  prioritas?: string;
  rekomendasi?: string;
  dasar?: string;
  saas_id?: string;
  [key: string]: unknown;
}

function bacaRekomendasi(isi: Record<string, unknown> | null): Rekomendasi[] {
  const r = isi?.['rekomendasi'];
  return Array.isArray(r) ? (r as Rekomendasi[]) : [];
}

export function ReportsPage() {
  const terbaruQ = useQuery({ queryKey: KUNCI.laporanTerbaru(), queryFn: ({ signal }) => api.laporanTerbaru(signal) });
  const daftarQ = useQuery({ queryKey: KUNCI.laporan(), queryFn: ({ signal }) => api.laporan(20, signal) });
  const [pilih, setPilih] = useState<string>('terbaru');

  const daftar = daftarQ.data?.data ?? [];
  const dipilih = pilih === 'terbaru' ? terbaruQ.data?.data ?? null : daftar.find((l) => l.id === pilih) ?? null;
  const isi = dipilih?.isi ?? null;
  const rekomendasi = bacaRekomendasi(isi);
  const ringkasan = typeof isi?.['ringkasan_portofolio'] === 'string' ? isi['ringkasan_portofolio'] : null;

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Laporan Agen Induk</h1>
          <p className="text-xs text-muted">Ringkasan harian portofolio dan rekomendasi tindakan (FR-6.3).</p>
        </div>
        <Select className="h-8 w-auto text-xs" aria-label="Pilih laporan" value={pilih} onChange={(e) => setPilih(e.target.value)}>
          <option value="terbaru">Laporan terbaru</option>
          {daftar.map((l) => (
            <option key={l.id} value={l.id}>
              {l.periode} · {fmtWaktu(l.dibuatPada)}
            </option>
          ))}
        </Select>
      </header>

      {terbaruQ.isError && pilih === 'terbaru' ? <Galat error={terbaruQ.error} onRetry={() => void terbaruQ.refetch()} /> : null}
      {terbaruQ.isLoading ? <Memuat label="Memuat laporan…" /> : null}

      {!terbaruQ.isLoading && !dipilih ? (
        <Kosong
          judul="Belum ada laporan hari ini"
          deskripsi="Laporan dibuat oleh siklus harian (Cron 01:00 UTC) atau tombol “Siklus harian” di halaman portofolio."
          ikon={<FileText className="size-6" aria-hidden="true" />}
        />
      ) : null}

      {dipilih ? (
        <div className="grid gap-3">
          <Card>
            <CardHeader
              judul={`Ringkasan ${dipilih.periode}`}
              deskripsi={`Dibuat ${fmtWaktu(dipilih.dibuatPada)}`}
              ikon={<FileText className="size-4" aria-hidden="true" />}
            />
            <p className="whitespace-pre-wrap px-4 py-3 text-sm">{ringkasan ?? 'Laporan tanpa ringkasan portofolio.'}</p>
            {isi && Object.keys(isi).length > 0 ? (
              <details className="border-t border-line px-4 py-2 text-xs">
                <summary className="cursor-pointer text-muted">Struktur lengkap laporan</summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(isi, null, 2)}</pre>
              </details>
            ) : null}
          </Card>

          <Card>
            <CardHeader judul="Rekomendasi" deskripsi={`${rekomendasi.length} butir`} />
            {rekomendasi.length === 0 ? <Kosong judul="Tidak ada rekomendasi" /> : null}
            <ul className="grid divide-y divide-line">
              {rekomendasi.map((r, i) => (
                <li key={i} className="flex flex-wrap items-start gap-2 px-4 py-2 text-sm">
                  <Badge nada={r.prioritas === 'tinggi' ? 'bad' : r.prioritas === 'rendah' ? 'netral' : 'warn'}>
                    {r.prioritas === 'tinggi' ? <AlertTriangle className="size-3" aria-hidden="true" /> : <ArrowUpRight className="size-3" aria-hidden="true" />}
                    {r.prioritas ?? 'sedang'}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    {r.rekomendasi ?? '—'}
                    {r.dasar ? <span className="block text-[11px] text-muted">{r.dasar}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      {daftar.length > 0 ? (
        <Card>
          <CardHeader judul="Riwayat laporan" deskripsi="20 laporan terakhir" />
          <ul className="grid grid-cols-1 gap-1 px-4 py-3 text-xs sm:grid-cols-2">
            {daftar.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => setPilih(l.id)}
                  className={cn('w-full rounded px-2 py-1 text-left hover:bg-surface-2', pilih === l.id && 'bg-surface-2 font-medium text-accent')}
                >
                  <span className="tabular">{l.periode}</span> <span className="text-muted">· {fmtWaktu(l.dibuatPada)}</span>
                  {l.saasId ? <span className="ml-1 text-muted">(unit)</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
