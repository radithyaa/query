/**
 * Antrean persetujuan (FR-7.3, FR-7.7): draf konten, balasan ulasan, PR, rencana
 * pemulihan, dan usulan sunset dengan tombol setujui / minta revisi / tolak.
 *
 * Filter SaaS Unit + status + fungsi + jenis (FR-7.6). Keputusan `sunset`
 * diarahkan ke alur khusus pemilik + MFA (`/sunset`), bukan ke dialog biasa.
 */
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BookLock, Filter, Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type Approval, type ApprovalStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  APPROVAL_KHUSUS_PEMILIK,
  fmtSisa,
  fmtWaktu,
  labelApproval,
  labelFungsi,
} from '../lib/format';
import { KUNCI, useNamaUnit, useSemuaUnit } from '../lib/queries';
import type { SearchPersetujuan } from '../lib/search';
import { DialogKeputusan } from '../components/ApprovalDialog';
import { Badge, Card, CardHeader, cn, Galat, Kosong, Memuat, Select, Tabel, kelasTd, kelasTh } from '../components/ui';

const STATUS: ApprovalStatus[] = ['menunggu', 'disetujui', 'ditolak', 'revisi', 'kedaluwarsa'];

const JENIS = [
  'terbit_post',
  'balas_ulasan',
  'merge_pr',
  'buat_issue',
  'rc_plan',
  'sunset',
  'ubah_harga',
  'kirim_email_massal',
  'beli_iklan',
  'render_video',
  'lainnya',
] as const;

export function ApprovalsPage() {
  const search = useSearch({ from: '/persetujuan' });
  const navigate = useNavigate();
  const { owner } = useAuth();
  const namaUnit = useNamaUnit();
  const unitsQ = useSemuaUnit();
  const status: ApprovalStatus = search.status ?? 'menunggu';
  const saasId = search.saas ?? '';
  const fungsi = search.fungsi ?? '';
  const jenis = search.jenis ?? '';
  const [dipilih, setDipilih] = useState<Approval | null>(null);

  const q = useQuery({
    queryKey: KUNCI.approvals(status),
    queryFn: ({ signal }) => api.approvals({ status, limit: 200, signal }),
  });

  const rows = useMemo(() => {
    const daftar = q.data?.data ?? [];
    return daftar.filter((a) => (!saasId || a.saasId === saasId) && (!fungsi || a.fungsi === fungsi) && (!jenis || a.jenis === jenis));
  }, [q.data, saasId, fungsi, jenis]);

  const { data: sunsetQ } = useQuery({ queryKey: KUNCI.sunset(), queryFn: ({ signal }) => api.sunsetList(signal) });
  const sunsetMenunggu = (sunsetQ?.data ?? []).filter((k) => !k.keputusan).length;

  const navigasi = (patch: Partial<SearchPersetujuan>) => {
    // Nilai filter saat ini berasal dari `useSearch` (bertipe), bukan argumen reducer,
    // karena argumen reducer dilebarkan menjadi Record<string, unknown> oleh router.
    const hasil: SearchPersetujuan = {
      saas: patch.saas !== undefined ? patch.saas || undefined : search.saas,
      fungsi: patch.fungsi !== undefined ? patch.fungsi || undefined : search.fungsi,
      jenis: patch.jenis !== undefined ? patch.jenis || undefined : search.jenis,
      status: patch.status !== undefined ? patch.status : search.status,
    };
    void navigate({ to: '/persetujuan', search: hasil });
  };

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Antrean persetujuan</h1>
          <p className="text-xs text-muted">
            Tindakan berisiko dari agen menunggu keputusan Anda. Permintaan kedaluwarsa tidak dijalankan (FR-9.3).
          </p>
        </div>
        {sunsetMenunggu > 0 ? (
          <Link
            to="/sunset"
            className="flex items-center gap-2 rounded-md border border-bad/40 bg-bad-soft px-3 py-1.5 text-xs text-bad no-underline hover:opacity-90"
          >
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {sunsetMenunggu} usulan sunset menunggu keputusan (MFA)
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </header>

      <Card>
        <CardHeader
          judul={`${rows.length} permintaan`}
          deskripsi={`status ${status}`}
          ikon={<Filter className="size-4" aria-hidden="true" />}
          aksi={
            <div className="flex flex-wrap items-center gap-2">
              <Select className="h-8 w-auto text-xs" aria-label="Filter status" value={status} onChange={(e) => navigasi({ status: e.target.value as ApprovalStatus })}>
                {STATUS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
              <Select className="h-8 w-auto text-xs" aria-label="Filter SaaS Unit" value={saasId} onChange={(e) => navigasi({ saas: e.target.value || undefined })}>
                <option value="">Semua SaaS Unit</option>
                {(unitsQ.data?.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nama}
                  </option>
                ))}
              </Select>
              <Select className="h-8 w-auto text-xs" aria-label="Filter fungsi" value={fungsi} onChange={(e) => navigasi({ fungsi: e.target.value || undefined })}>
                <option value="">Semua fungsi</option>
                {['promosi', 'review', 'kode', 'support', 'parent'].map((f) => (
                  <option key={f} value={f}>
                    {labelFungsi(f)}
                  </option>
                ))}
              </Select>
              <Select className="h-8 w-auto text-xs" aria-label="Filter jenis" value={jenis} onChange={(e) => navigasi({ jenis: e.target.value || undefined })}>
                <option value="">Semua jenis</option>
                {JENIS.map((j) => (
                  <option key={j} value={j}>
                    {labelApproval(j)}
                  </option>
                ))}
              </Select>
            </div>
          }
        />

        {q.isError ? (
          <div className="p-3">
            <Galat error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : null}
        {q.isLoading ? <Memuat /> : null}

        {!q.isLoading && rows.length === 0 ? (
          <Kosong
            judul="Tidak ada permintaan"
            deskripsi="Agen belum mengajukan tindakan yang membutuhkan persetujuan untuk filter ini."
            ikon={<Inbox className="size-6" aria-hidden="true" />}
          />
        ) : null}

        {rows.length > 0 ? (
          <Tabel>
            <thead>
              <tr>
                <th scope="col" className={kelasTh}>Diajukan</th>
                <th scope="col" className={kelasTh}>SaaS Unit</th>
                <th scope="col" className={kelasTh}>Jenis</th>
                <th scope="col" className={kelasTh}>Ringkasan dampak</th>
                <th scope="col" className={kelasTh}>Kedaluwarsa</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Keputusan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const khusus = APPROVAL_KHUSUS_PEMILIK.has(a.jenis);
                const lewat = a.status === 'menunggu' && a.kedaluwarsa <= Date.now();
                const unit = namaUnit(a.saasId);
                return (
                  <tr key={a.id} className="hover:bg-surface-2/60">
                    <td className={cn(kelasTd, 'whitespace-nowrap text-xs text-muted')}>{fmtWaktu(a.dibuatPada)}</td>
                    <td className={kelasTd}>
                      <Link to="/saas/$id" params={{ id: a.saasId }} className="text-xs font-medium text-fg no-underline hover:text-accent">
                        {unit.nama}
                      </Link>
                      <div className="text-[11px] text-muted">{labelFungsi(a.fungsi)}</div>
                    </td>
                    <td className={kelasTd}>
                      <div className="flex flex-wrap gap-1">
                        <Badge nada="info">{labelApproval(a.jenis)}</Badge>
                        {khusus ? <Badge nada="warn">pemilik</Badge> : null}
                      </div>
                    </td>
                    <td className={cn(kelasTd, 'max-w-md text-xs')}>{a.ringkasanDampak}</td>
                    <td className={cn(kelasTd, 'whitespace-nowrap text-xs', lewat ? 'text-bad' : a.status === 'menunggu' ? 'text-warn' : 'text-muted')}>
                      {a.status === 'menunggu' ? (lewat ? 'kedaluwarsa' : fmtSisa(a.kedaluwarsa)) : fmtWaktu(a.kedaluwarsa)}
                    </td>
                    <td className={cn(kelasTd, 'text-right')}>
                      {a.jenis === 'sunset' ? (
                        <Link to="/sunset" className="inline-flex items-center gap-1 text-xs text-accent no-underline hover:underline">
                          <BookLock className="size-3.5" aria-hidden="true" /> Putuskan di Sunset
                        </Link>
                      ) : a.status === 'menunggu' ? (
                        <button
                          type="button"
                          className="rounded-md border border-line px-2.5 py-1 text-xs font-medium hover:border-accent hover:text-accent"
                          onClick={() => setDipilih(a)}
                          disabled={lewat}
                        >
                          {khusus && !owner ? 'Lihat (khusus pemilik)' : 'Putuskan'}
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted">
                          {a.status}
                          {a.diputuskanOleh ? ` · ${a.diputuskanOleh}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Tabel>
        ) : null}
      </Card>

      <DialogKeputusan
        approval={dipilih}
        terbuka={dipilih !== null}
        onTutup={() => setDipilih(null)}
        {...(dipilih?.jenis === 'merge_pr' ? { gambar: 'SETUJUI' } : {})}
      />
    </div>
  );
}
