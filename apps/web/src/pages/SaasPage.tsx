/**
 * Detail SaaS Unit (FR-7.2): metrik historis, aktivitas agen, konten, ulasan,
 * PR, insiden, evaluasi Health, dan aksi pemilik (FR-7.7: jeda, kill switch,
 * konfigurasi, kopi id untuk filter lintas halaman).
 *
 * Bagian konten/ulasan/PR/insiden menampilkan data dari approval dan log audit
 * unit — API belum menyediakan endpoint khusus untuk tabel turunan tersebut,
 * jadi bagian yang kosong dinyatakan apa adanya, bukan dipalsukan.
 */
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Activity,
  ClipboardList,
  Coins,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  Newspaper,
  OctagonX,
  Pause,
  Play,
  Settings2,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import { api, type Approval, type MetrikHarian, type SaasDetail } from '../lib/api';
import { pesanGalat, useAuth } from '../lib/auth';
import {
  APPROVAL_KHUSUS_PEMILIK,
  fmtAngka,
  fmtDesimal,
  fmtPersen,
  fmtSisa,
  fmtTanggal,
  fmtTanggalSingkat,
  fmtWaktu,
  labelApproval,
  labelFungsi,
  labelKomponen,
  labelStatus,
  labelTahapSunset,
  nadaStatus,
  PERIODE,
} from '../lib/format';
import { KUNCI } from '../lib/queries';
import { periodeValid } from '../lib/search';
import { DialogKeputusan } from '../components/ApprovalDialog';
import { GrafikGaris, type TitikSeri } from '../components/Grafik';
import { KillSwitchForm } from '../components/KillSwitch';
import {
  Badge,
  Bar,
  Card,
  CardHeader,
  cn,
  Dialog,
  Galat,
  Kosong,
  Memuat,
  Select,
  SkorRing,
  Tabel,
  kelasTd,
  kelasTh,
  Tombol,
  useToast,
} from '../components/ui';

function blok(metrik: MetrikHarian | undefined, nama: 'bisnis' | 'produk' | 'toko_aplikasi' | 'stabilitas' | 'biaya', kunci: string): number | null {
  const b = metrik?.metrik?.[nama];
  if (!b || typeof b !== 'object') return null;
  const v = (b as Record<string, unknown>)[kunci];
  return typeof v === 'number' ? v : null;
}

function seri(rows: MetrikHarian[], ambil: (m: MetrikHarian | undefined) => number | null): TitikSeri[] {
  return [...rows].reverse().map((r) => ({ label: fmtTanggalSingkat(r.tanggal), nilai: ambil(r) }));
}

export function SaasPage() {
  const { id } = useParams({ from: '/saas/$id' });
  const search = useSearch({ from: '/saas/$id' });
  const navigate = useNavigate();
  const { owner } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const periode = periodeValid(search.periode);
  const [killBuka, setKillBuka] = useState(false);
  const [configBuka, setConfigBuka] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [tab, setTab] = useState<'metrik' | 'aktivitas' | 'konfigurasi'>('metrik');

  const statusQ = useQuery({ queryKey: KUNCI.status(id), queryFn: ({ signal }) => api.status(id, signal) });
  const unitQ = useQuery({ queryKey: KUNCI.unit(id), queryFn: ({ signal }) => api.unit(id, signal) });
  const metrikQ = useQuery({ queryKey: KUNCI.metrik(id, periode), queryFn: ({ signal }) => api.metrik(id, periode, signal) });
  const approvalsQ = useQuery({
    queryKey: KUNCI.persetujuanUnit(id),
    queryFn: ({ signal }) => api.approvals({ status: 'menunggu', saas_id: id, limit: 50, signal }),
  });

  const jeda = useMutation({
    mutationFn: (paused: boolean) => api.jeda(id, paused),
    onSuccess: async (_r, paused) => {
      toast.sukses(paused ? 'Agen unit ini dijeda.' : 'Agen unit ini dilanjutkan.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['status'] }),
        qc.invalidateQueries({ queryKey: ['summary'] }),
        qc.invalidateQueries({ queryKey: ['unit'] }),
        qc.invalidateQueries({ queryKey: ['killswitch'] }),
      ]);
    },
    onError: (error) => toast.galat(pesanGalat(error)),
  });

  if (statusQ.isLoading) return <Memuat label="Memuat SaaS Unit…" />;
  if (statusQ.isError) return <Galat error={statusQ.error} onRetry={() => void statusQ.refetch()} />;

  const s = statusQ.data?.data;
  if (!s) return <Kosong judul="SaaS Unit tidak ditemukan" />;
  const u = unitQ.data?.data;
  const metrik = metrikQ.data?.data ?? [];
  const terbaru = metrik[0];
  const pending = approvalsQ.data?.data ?? [];

  const aktivitas = s.evaluasi.slice(0, 20);

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link to="/" search={{ periode }} className="inline-flex w-fit items-center gap-1 text-xs text-muted no-underline hover:text-fg">
            <ArrowLeft className="size-3.5" aria-hidden="true" /> Portofolio
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-fg">{s.nama}</h1>
            <Badge nada={nadaStatus(s.status)}>{labelStatus(s.status)}</Badge>
            {s.paused ? <Badge nada="warn">dijeda</Badge> : null}
            {!s.data_cukup ? <Badge nada="netral">data tidak cukup</Badge> : null}
            <span className="text-[11px] text-muted">status sejak {fmtTanggal(s.status_sejak)}</span>
          </div>
          {u ? (
            <p className="text-[11px] text-muted">
              {u.repo ? <span className="mr-2 font-mono">{u.repo}</span> : null}
              {u.akun_toko ? <span className="mr-2">{u.akun_toko}</span> : null}
              {u.akun_sosial ? <span>{u.akun_sosial}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          <Select
            className="h-8 w-auto text-xs"
            aria-label="Periode"
            value={periode}
            onChange={(e) => void navigate({ to: '/saas/$id', params: { id }, search: { periode: periodeValid(Number(e.target.value)) } })}
          >
            {PERIODE.map((p) => (
              <option key={p.nilai} value={p.nilai}>
                {p.label}
              </option>
            ))}
          </Select>
          <Tombol ukuran="sm" onClick={() => void navigate({ to: '/audit', search: { saas: id } })}>
            <ClipboardList className="size-3.5" aria-hidden="true" /> Log audit
          </Tombol>
          {owner ? (
            <>
              <Tombol ukuran="sm" onClick={() => jeda.mutate(!s.paused)} memuat={jeda.isPending}>
                {s.paused ? <Play className="size-3.5" aria-hidden="true" /> : <Pause className="size-3.5" aria-hidden="true" />}
                {s.paused ? 'Cabut jeda' : 'Jeda agen'}
              </Tombol>
              <Tombol ukuran="sm" onClick={() => setConfigBuka(true)}>
                <Settings2 className="size-3.5" aria-hidden="true" /> Konfigurasi
              </Tombol>
              <Tombol ukuran="sm" varian="bahaya" onClick={() => setKillBuka(true)}>
                <OctagonX className="size-3.5" aria-hidden="true" /> Kill switch
              </Tombol>
            </>
          ) : null}
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-3">
          <Card>
            <CardHeader
              judul="Health Score & komponen"
              deskripsi={<span className="line-clamp-2">{s.alasan ?? 'Belum ada evaluasi'}</span>}
              aksi={
                <div className="flex items-center gap-2">
                  <SkorRing skor={s.skor} ukuran={46} />
                  <span className="text-xs text-muted">evaluasi terbaru {aktivitas[0] ? fmtTanggal(aktivitas[0].tanggal) : '—'}</span>
                </div>
              }
            />
            <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
              <ul className="grid gap-2">
                {s.komponen.length === 0 ? <li className="text-xs text-muted">Komponen belum tersedia.</li> : null}
                {s.komponen.map((k) => {
                  const nilai = typeof k.score === 'number' ? k.score : null;
                  return (
                    <li key={k.key} className="grid gap-1">
                      <span className="flex justify-between gap-2 text-xs">
                        <span className="text-muted">
                          {labelKomponen(k.key)}
                          {typeof k.bobot === 'number' ? <span className="ml-1 opacity-70">({k.bobot}%)</span> : null}
                          {k.terpakai === false ? <span className="ml-1 text-warn">tidak dipakai</span> : null}
                        </span>
                        <span className="tabular font-medium">{nilai === null ? '—' : Math.round(nilai)}</span>
                      </span>
                      <Bar nilai={nilai ?? 0} nada={nilai === null ? 'netral' : nilai >= 70 ? 'ok' : nilai >= 55 ? 'warn' : 'bad'} />
                    </li>
                  );
                })}
              </ul>
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted">Tren Health Score</p>
                <GrafikGaris
                  nama="Health Score"
                  seri={[...aktivitas].reverse().map((e) => ({ label: fmtTanggalSingkat(e.tanggal), nilai: e.skor }))}
                  minEksplisit={0}
                  maxEksplisit={100}
                  warna="var(--c-ok)"
                  tinggi={150}
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              judul="Rincian"
              aksi={
                <div className="inline-flex overflow-hidden rounded-md border border-line" role="tablist">
                  {(
                    [
                      ['metrik', 'Metrik & konten'],
                      ['aktivitas', 'Aktivitas agen'],
                      ['konfigurasi', 'Konfigurasi'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      onClick={() => setTab(k)}
                      className={cn('px-2.5 py-1 text-xs', tab === k ? 'bg-accent text-accent-fg' : 'bg-surface text-muted hover:bg-surface-2')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              }
            />

            {tab === 'metrik' ? (
              <div className="grid gap-4 p-4">
                {metrikQ.isLoading ? <Memuat label="Memuat metrik…" /> : null}
                {metrik.length === 0 && !metrikQ.isLoading ? (
                  <Kosong judul="Belum ada metrik" deskripsi="Metrik tersedia setelah konektor mengirim data atau siklus harian dijalankan." />
                ) : null}
                {metrik.length > 0 ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-[11px] font-medium text-muted">MRR (jendela {periode} hari)</p>
                        <GrafikGaris nama="MRR" seri={seri(metrik, (m) => blok(m, 'bisnis', 'mrr'))} satuan=" IDR" />
                      </div>
                      <div>
                        <p className="mb-1 text-[11px] font-medium text-muted">Rating toko aplikasi</p>
                        <GrafikGaris
                          nama="Rating"
                          seri={seri(metrik, (m) => blok(m, 'toko_aplikasi', 'rating_rata2'))}
                          minEksplisit={0}
                          maxEksplisit={5}
                          warna="var(--c-warn)"
                        />
                      </div>
                    </div>

                    <Tabel>
                      <thead>
                        <tr>
                          <th scope="col" className={kelasTh}>Tanggal</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>MRR</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Pelanggan</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Signup</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Churn</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Rating</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Uptime</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Biaya infra</th>
                          <th scope="col" className={cn(kelasTh, 'text-right')}>Biaya agen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metrik.slice(0, 28).map((m) => (
                          <tr key={m.tanggal}>
                            <td className={cn(kelasTd, 'tabular')}>{fmtTanggal(m.tanggal)}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(blok(m, 'bisnis', 'mrr'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(blok(m, 'bisnis', 'pelanggan_aktif'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(blok(m, 'bisnis', 'signup_baru'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtPersen(blok(m, 'bisnis', 'churn_bulanan_persen'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtDesimal(blok(m, 'toko_aplikasi', 'rating_rata2'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtPersen(blok(m, 'stabilitas', 'uptime_persen'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(blok(m, 'biaya', 'infra'))}</td>
                            <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(blok(m, 'biaya', 'agen'))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Tabel>
                    {terbaru ? (
                      <p className="text-[11px] text-muted">
                        Metrik terbaru {fmtTanggal(terbaru.tanggal)} diterima {fmtWaktu(terbaru.diterima_pada)}.
                      </p>
                    ) : null}
                  </>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-3">
                  <BagianKonten judul="Konten & ulasan" ikon={<MessageSquare className="size-4" aria-hidden="true" />} pending={pending.filter((a) => ['terbit_post', 'balas_ulasan', 'render_video'].includes(a.jenis))} onPilih={setApproval} />
                  <BagianKonten judul="PR & engineering" ikon={<GitPullRequest className="size-4" aria-hidden="true" />} pending={pending.filter((a) => ['merge_pr', 'buat_issue'].includes(a.jenis))} onPilih={setApproval} />
                  <BagianKonten judul="Sunset & rencana" ikon={<Newspaper className="size-4" aria-hidden="true" />} pending={pending.filter((a) => ['rc_plan', 'sunset'].includes(a.jenis))} onPilih={setApproval} />
                </div>
              </div>
            ) : null}

            {tab === 'aktivitas' ? (
              <div className="grid gap-3 p-4">
                <p className="flex items-center gap-1 text-[11px] text-muted">
                  <Activity className="size-3.5" aria-hidden="true" /> Evaluasi Health terakhir (alasan perubahan status, FR-8.8). Riwayat job & run agen
                  lengkap ada di log audit.
                </p>
                <Tabel>
                  <thead>
                    <tr>
                      <th scope="col" className={kelasTh}>Tanggal</th>
                      <th scope="col" className={cn(kelasTh, 'text-right')}>Skor</th>
                      <th scope="col" className={kelasTh}>Transisi</th>
                      <th scope="col" className={kelasTh}>Alasan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aktivitas.map((e) => (
                      <tr key={`${e.tanggal}-${e.status_baru}`}>
                        <td className={cn(kelasTd, 'tabular')}>{fmtTanggal(e.tanggal)}</td>
                        <td className={cn(kelasTd, 'tabular text-right')}>{Math.round(e.skor)}</td>
                        <td className={kelasTd}>
                          <span className="flex flex-wrap items-center gap-1 text-[11px]">
                            <Badge nada={nadaStatus(e.status_lama)}>{labelStatus(e.status_lama)}</Badge>→
                            <Badge nada={nadaStatus(e.status_baru)}>{labelStatus(e.status_baru)}</Badge>
                          </span>
                        </td>
                        <td className={cn(kelasTd, 'text-xs text-muted')}>{e.alasan || '—'}</td>
                      </tr>
                    ))}
                    {aktivitas.length === 0 ? (
                      <tr>
                        <td colSpan={4} className={cn(kelasTd, 'text-center text-muted')}>
                          Belum ada evaluasi.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </Tabel>
                {s.sunset ? (
                  <p className="text-xs text-muted">
                    Kasus sunset: {labelTahapSunset(s.sunset.tahap)} · keputusan {s.sunset.keputusan ?? 'belum ada'} ·{' '}
                    {fmtTanggal(s.sunset.dibuat_pada)}
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === 'konfigurasi' ? (
              <div className="grid gap-3 p-4">
                {u ? <KonfigurasiLihat unit={u} /> : <Memuat label="Memuat konfigurasi…" />}
              </div>
            ) : null}
          </Card>
        </div>

        <aside className="grid content-start gap-3">
          <Card>
            <CardHeader judul="Persetujuan menunggu" ikon={<ClipboardList className="size-4" aria-hidden="true" />} />
            {approvalsQ.isLoading ? <Memuat /> : null}
            {pending.length === 0 && !approvalsQ.isLoading ? (
              <Kosong judul="Tidak ada permintaan" deskripsi="Agen belum mengajukan tindakan yang butuh keputusan." />
            ) : (
              <ul className="grid divide-y divide-line">
                {pending.map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <button type="button" className="grid w-full gap-1 text-left" onClick={() => setApproval(a)}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-fg">{labelApproval(a.jenis)}</span>
                        <Badge nada={APPROVAL_KHUSUS_PEMILIK.has(a.jenis) ? 'info' : 'warn'}>{labelFungsi(a.fungsi)}</Badge>
                      </span>
                      <span className="text-[11px] text-muted">{a.ringkasanDampak}</span>
                      <span className="text-[11px] text-warn">kedaluwarsa {fmtSisa(a.kedaluwarsa)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader judul="Tautan" ikon={<ExternalLink className="size-4" aria-hidden="true" />} />
            <div className="grid gap-1 p-3 text-xs">
              <Link to="/persetujuan" search={{ saas: id }} className="text-accent no-underline hover:underline">
                Semua persetujuan unit ini
              </Link>
              <Link to="/audit" search={{ saas: id }} className="text-accent no-underline hover:underline">
                Log audit unit ini
              </Link>
              <Link to="/biaya" className="text-accent no-underline hover:underline">
                Panel biaya
              </Link>
            </div>
          </Card>

          {u && u.konektor.length > 0 ? (
            <Card>
              <CardHeader judul="Konektor" ikon={<Terminal className="size-4" aria-hidden="true" />} />
              <ul className="grid gap-1 px-4 py-3 text-xs">
                {u.konektor.map((k) => (
                  <li key={k.jenis} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px]">{k.jenis}</span>
                    <span className="flex items-center gap-1">
                      {k.utama ? <Badge nada="info">utama</Badge> : null}
                      <span className="text-[11px] text-muted">{k.terakhir_sehat ? fmtWaktu(k.terakhir_sehat) : 'belum sehat'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>

      <Dialog terbuka={killBuka} onTutup={() => setKillBuka(false)} judul={`Kill switch — ${s.nama}`} deskripsi="Menghentikan agen unit ini seketika (NFR-8).">
        <KillSwitchForm saasAwal={id} onSelesai={() => setKillBuka(false)} />
      </Dialog>

      {owner && u ? <DialogKonfigurasi unit={u} terbuka={configBuka} onTutup={() => setConfigBuka(false)} /> : null}

      <DialogKeputusan approval={approval} terbuka={approval !== null} onTutup={() => setApproval(null)} />
    </div>
  );
}

function BagianKonten({ judul, ikon, pending, onPilih }: { judul: string; ikon: React.ReactNode; pending: Approval[]; onPilih: (a: Approval) => void }) {
  return (
    <div className="rounded-md border border-line p-2">
      <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-fg">
        {ikon} {judul}
      </p>
      {pending.length === 0 ? (
        <p className="text-[11px] text-muted">Tidak ada permintaan menunggu. Data terbit/riwayat tersedia di log audit.</p>
      ) : (
        <ul className="grid gap-1">
          {pending.map((a) => (
            <li key={a.id}>
              <button type="button" className="text-left text-[11px] text-accent hover:underline" onClick={() => onPilih(a)}>
                {labelApproval(a.jenis)} — {a.ringkasanDampak}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KonfigurasiLihat({ unit }: { unit: SaasDetail }) {
  const c = unit.config ?? {};
  const anggaran = (c['anggaran_bulanan_usd'] as Record<string, number> | undefined) ?? {};
  const otonomi = (c['otonomi'] as Record<string, string> | undefined) ?? {};
  const kriteria = (c['kriteria_bangkit'] as Record<string, unknown> | undefined) ?? {};
  const syarat = Array.isArray(kriteria['syarat']) ? (kriteria['syarat'] as Array<Record<string, unknown>>) : [];
  return (
    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted">Otonomi per fungsi</dt>
      <dd className="flex flex-wrap gap-1">
        {Object.keys(otonomi).length === 0 ? <span className="text-muted">default</span> : null}
        {Object.entries(otonomi).map(([f, v]) => (
          <Badge key={f} nada="info">
            {labelFungsi(f)}: {v}
          </Badge>
        ))}
      </dd>
      <dt className="text-muted">Anggaran / bulan</dt>
      <dd className="flex flex-wrap gap-1">
        {Object.keys(anggaran).length === 0 ? <span className="text-muted">tidak ditetapkan</span> : null}
        {Object.entries(anggaran).map(([f, v]) => (
          <Badge key={f}>
            {f}: ${v}
          </Badge>
        ))}
      </dd>
      <dt className="text-muted">Masa percobaan</dt>
      <dd>{String(kriteria['masa_percobaan_hari'] ?? '—')} hari · jendela evaluasi {String(kriteria['jendela_evaluasi_hari'] ?? '—')} hari</dd>
      <dt className="text-muted">Kriteria bangkit</dt>
      <dd>
        {syarat.length === 0 ? (
          <span className="text-muted">tidak ada</span>
        ) : (
          <ul className="grid gap-0.5">
            {syarat.map((s, i) => (
              <li key={i}>
                {String(s['metrik'])}
                {s['minimal'] !== undefined ? ` ≥ ${String(s['minimal'])}` : ''}
                {s['maksimal'] !== undefined ? ` ≤ ${String(s['maksimal'])}` : ''}
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt className="text-muted">Fungsi aktif</dt>
      <dd>{Array.isArray(c['fungsi_aktif']) ? (c['fungsi_aktif'] as string[]).map(labelFungsi).join(', ') : '—'}</dd>
      <dt className="text-muted">Pengecualian sunset</dt>
      <dd>{c['pengecualian_sunset'] ? 'ya' : 'tidak'}</dd>
      <dt className="text-muted">Panduan merek</dt>
      <dd className="whitespace-pre-wrap">{String(c['panduan_merek'] ?? '—')}</dd>
    </dl>
  );
}

function useUnitData() {
  const { id } = useParams({ from: '/saas/$id' });
  const { data } = useQuery({ queryKey: KUNCI.unit(id), queryFn: ({ signal }) => api.unit(id, signal) });
  return data?.data;
}
function DialogKonfigurasi({ unit, terbuka, onTutup }: { unit: SaasDetail; terbuka: boolean; onTutup: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { id } = useParams({ from: '/saas/$id' });
  const awalOtonomi = (unit.config?.['otonomi'] as Record<string, string> | undefined) ?? {};
  const awalAnggaran = (unit.config?.['anggaran_bulanan_usd'] as Record<string, number> | undefined) ?? {};
  const [otonomi, setOtonomi] = useState<Record<string, string>>(awalOtonomi);
  const [anggaran, setAnggaran] = useState<Record<string, string>>(
    Object.fromEntries(['promosi', 'review', 'kode', 'support'].map((f) => [f, String(awalAnggaran[f] ?? '')])),
  );
  const [pengecualian, setPengecualian] = useState(Boolean(unit.config?.['pengecualian_sunset']));
  const [galat, setGalat] = useState<unknown>(null);

  const simpan = useMutation({
    mutationFn: () => {
      const anggaranNum = Object.fromEntries(
        Object.entries(anggaran)
          .filter(([, v]) => v !== '' && Number(v) >= 0)
          .map(([f, v]) => [f, Number(v)]),
      );
      return api.ubahConfig(id, {
        otonomi,
        anggaran_bulanan_usd: anggaranNum,
        pengecualian_sunset: pengecualian,
      });
    },
    onSuccess: async () => {
      toast.sukses('Konfigurasi disimpan (tercatat di audit sebagai saas.config).');
      setGalat(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['unit'] }), qc.invalidateQueries({ queryKey: ['summary'] })]);
      onTutup();
    },
    onError: (error) => setGalat(error),
  });

  return (
    <Dialog terbuka={terbuka} onTutup={onTutup} judul={`Konfigurasi — ${unit.nama}`} deskripsi="Perubahan dicatat di log audit sebagai saas.config." lebar="md">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          simpan.mutate();
        }}
      >
        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-fg">Tingkat otonomi</legend>
          {(['promosi', 'review', 'kode', 'support'] as const).map((f) => (
            <label key={f} className="grid grid-cols-[6rem_1fr] items-center gap-2 text-xs">
              <span>{labelFungsi(f)}</span>
              <Select
                className="h-8 text-xs"
                value={otonomi[f] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setOtonomi((lama) => {
                    const salinan = { ...lama };
                    if (v) salinan[f] = v;
                    else delete salinan[f];
                    return salinan;
                  });
                }}
              >
                <option value="">default</option>
                <option value="draf">Draf saja</option>
                <option value="persetujuan">Persetujuan</option>
                <option value="otonom">Otonom terbatas</option>
              </Select>
            </label>
          ))}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-fg">Anggaran agen (USD/bulan)</legend>
          <div className="grid grid-cols-2 gap-2">
            {Object.keys(anggaran).map((f) => (
              <label key={f} className="grid gap-0.5 text-xs">
                <span className="text-muted">{labelFungsi(f)}</span>
                <input
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm"
                  type="number"
                  min={0}
                  step={1}
                  value={anggaran[f]}
                  onChange={(e) => setAnggaran((l) => ({ ...l, [f]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={pengecualian} onChange={(e) => setPengecualian(e.target.checked)} />
          Pengecualian sunset (unit strategis/musiman; menahan usulan sunset — FR-8.7)
        </label>

        {galat ? <Galat error={galat} /> : null}

        <div className="flex justify-end gap-2">
          <Tombol onClick={onTutup} disabled={simpan.isPending}>
            Batal
          </Tombol>
          <Tombol type="submit" varian="utama" memuat={simpan.isPending}>
            <Coins className="size-4" aria-hidden="true" /> Simpan
          </Tombol>
        </div>
      </form>
    </Dialog>
  );
}

