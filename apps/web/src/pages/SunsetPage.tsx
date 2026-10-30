/**
 * Sunset (FR-8.5, FR-8.6, FR-7.7): usulan yang menunggu keputusan pemilik (MFA)
 * dan pelaksanaan tahap bertahap hingga arsip. Penghentian final tidak otonom.
 */
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarRange } from 'lucide-react';
import { useState } from 'react';
import { api, type SunsetCase } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtTanggal, fmtWaktu, labelTahapSunset, URUTAN_TAHAP_SUNSET } from '../lib/format';
import { KUNCI, useNamaUnit } from '../lib/queries';
import { DialogKeputusanSunset, DialogMajuSunset } from '../components/SunsetDialogs';
import { Badge, Card, CardHeader, cn, Galat, Kosong, Memuat, Tabel, kelasTd, kelasTh, Tombol } from '../components/ui';

export function SunsetPage() {
  const { owner } = useAuth();
  const namaUnit = useNamaUnit();
  const [keputusan, setKeputusan] = useState<SunsetCase | null>(null);
  const [maju, setMaju] = useState<SunsetCase | null>(null);

  const q = useQuery({ queryKey: KUNCI.sunset(), queryFn: ({ signal }) => api.sunsetList(signal) });
  const daftar = q.data?.data ?? [];
  const menunggu = daftar.filter((k) => !k.keputusan);
  const berjalan = daftar.filter((k) => k.keputusan === 'disetujui' && k.tahap !== 'arsip');
  const selesai = daftar.filter((k) => k.tahap === 'arsip');

  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-lg font-semibold text-fg">Sunset</h1>
        <p className="text-xs text-muted">
          Agen Induk hanya mengusulkan. Keputusan memerlukan pemilik + autentikasi ulang MFA; pelaksanaan berjalan per tahap
          (FR-8.6) dan dicatat di log audit.
        </p>
      </header>

      {!owner ? (
        <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft p-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Anda masuk sebagai operator: halaman ini hanya-baca. Keputusan sunset ditolak untuk peran operator.
        </p>
      ) : null}

      {q.isError ? (
        <Galat error={q.error} onRetry={() => void q.refetch()} />
      ) : null}
      {q.isLoading ? <Memuat label="Memuat kasus sunset…" /> : null}

      <Card>
        <CardHeader judul="Menunggu keputusan pemilik" deskripsi={`${menunggu.length} usulan`} ikon={<CalendarRange className="size-4" aria-hidden="true" />} />
        {!q.isLoading && menunggu.length === 0 ? (
          <Kosong judul="Tidak ada usulan" deskripsi="Usulan dibuat otomatis ketika masa percobaan lewat tanpa kriteria bangkit." />
        ) : null}
        {menunggu.length > 0 ? (
          <ul className="grid divide-y divide-line">
            {menunggu.map((k) => (
              <li key={k.id} className="grid gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to="/saas/$id" params={{ id: k.saasId }} className="text-sm font-medium text-fg no-underline hover:text-accent">
                    {namaUnit(k.saasId).nama}
                  </Link>
                  <Badge nada="warn">menunggu keputusan</Badge>
                  <span className="text-[11px] text-muted">diusulkan {fmtWaktu(k.dibuatPada)}</span>
                </div>
                <RingkasBukti bukti={k.paketBukti} />
                <div>
                  <Tombol ukuran="sm" varian="bahaya" onClick={() => setKeputusan(k)} disabled={!owner}>
                    Putuskan (MFA)
                  </Tombol>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card>
        <CardHeader judul="Sedang berjalan" deskripsi="Tahap pengumuman → arsip" />
        {berjalan.length === 0 && !q.isLoading ? <Kosong judul="Tidak ada sunset berjalan" /> : null}
        {berjalan.length > 0 ? (
          <Tabel>
            <thead>
              <tr>
                <th scope="col" className={kelasTh}>SaaS Unit</th>
                <th scope="col" className={kelasTh}>Tahap</th>
                <th scope="col" className={kelasTh}>Kemajuan</th>
                <th scope="col" className={kelasTh}>Diputuskan</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {berjalan.map((k) => {
                const idx = URUTAN_TAHAP_SUNSET.indexOf(k.tahap as never);
                return (
                  <tr key={k.id}>
                    <td className={kelasTd}>
                      <Link to="/saas/$id" params={{ id: k.saasId }} className="text-sm font-medium no-underline hover:text-accent">
                        {namaUnit(k.saasId).nama}
                      </Link>
                    </td>
                    <td className={kelasTd}>
                      <Badge nada="warn">{labelTahapSunset(k.tahap)}</Badge>
                    </td>
                    <td className={kelasTd}>
                      <div className="flex items-center gap-1" aria-label={`tahap ${idx + 1} dari ${URUTAN_TAHAP_SUNSET.length}`}>
                        {URUTAN_TAHAP_SUNSET.map((t, i) => (
                          <span key={t} className={cn('h-1.5 w-5 rounded-full', i <= idx ? 'bg-warn' : 'bg-surface-2')} title={labelTahapSunset(t)} />
                        ))}
                      </div>
                    </td>
                    <td className={cn(kelasTd, 'text-xs text-muted')}>
                      {k.diputuskanOleh ?? '—'} · {k.diputuskanPada ? fmtWaktu(k.diputuskanPada) : '—'}
                    </td>
                    <td className={cn(kelasTd, 'text-right')}>
                      <Tombol ukuran="sm" onClick={() => setMaju(k)} disabled={!owner}>
                        Maju tahap <ArrowRight className="size-3.5" aria-hidden="true" />
                      </Tombol>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Tabel>
        ) : null}
      </Card>

      {selesai.length > 0 ? (
        <Card>
          <CardHeader judul="Diarsipkan" deskripsi={`${selesai.length} kasus selesai`} />
          <ul className="grid gap-1 px-4 py-3 text-xs text-muted">
            {selesai.map((k) => (
              <li key={k.id} className="flex flex-wrap gap-2">
                <span className="text-fg">{namaUnit(k.saasId).nama}</span>
                <span>arsip</span>
                <span>{k.catatan ?? '—'}</span>
                {k.tenggatBaru ? <span>tenggat {fmtTanggal(k.tenggatBaru)}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="text-[11px] text-muted">
        Keputusan tolak/pengecualian mengembalikan unit ke <strong>intervensi</strong> dengan tenggat baru (tabel FR-8).
      </p>

      <DialogKeputusanSunset kasus={keputusan} terbuka={keputusan !== null} onTutup={() => setKeputusan(null)} />
      <DialogMajuSunset kasus={maju} terbuka={maju !== null} onTutup={() => setMaju(null)} />
    </div>
  );
}

function RingkasBukti({ bukti }: { bukti: Record<string, unknown> }) {
  const kunci = Object.keys(bukti);
  if (kunci.length === 0) return <p className="text-[11px] text-muted">Paket bukti kosong.</p>;
  return (
    <div className="grid gap-1 rounded-md bg-surface-2 p-2 text-[11px]">
      {kunci.slice(0, 4).map((k) => {
        const v = bukti[k];
        const teks = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 160) : String(v);
        return (
          <p key={k} className="flex gap-2">
            <span className="w-28 shrink-0 text-muted">{k}</span>
            <span className="min-w-0 break-words text-fg">{teks}</span>
          </p>
        );
      })}
      {kunci.length > 4 ? <p className="text-muted">+{kunci.length - 4} bagian lain — lihat dialog keputusan.</p> : null}
    </div>
  );
}
