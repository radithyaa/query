/**
 * Halaman portofolio (FR-7.1) dengan filter status/periode/pencarian (FR-7.6) dan
 * aksi cepat pemilik per unit (FR-7.7): jeda/cabut jeda dan kill switch per SaaS,
 * keduanya dijangkau satu klik dari halaman ini (NFR-8).
 */
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleDollarSign,
  Filter,
  MoreHorizontal,
  OctagonX,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  TrendingDown,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type PortfolioRow } from '../lib/api';
import { pesanGalat, useAuth } from '../lib/auth';
import {
  FILTER_STATUS,
  fmtAngka,
  fmtDesimal,
  fmtPersen,
  fmtTanggal,
  fmtUang,
  labelPeringkat,
  nadaStatus,
  PERIODE,
} from '../lib/format';
import { KUNCI } from '../lib/queries';
import { periodeValid, type SearchPortofolio } from '../lib/search';
import {
  Badge,
  Bar,
  Card,
  CardHeader,
  cn,
  Dialog,
  Galat,
  Input,
  Kosong,
  Memuat,
  Select,
  SkorRing,
  Tabel,
  kelasTd,
  kelasTh,
  Tombol,
  useKlikLuar,
  useToast,
} from '../components/ui';
import { KillSwitchForm } from '../components/KillSwitch';
import { JalankanSiklus } from '../components/SiklusDialog';
import { DialogDaftarSaas } from '../components/DaftarSaas';

type Urut = 'skor' | 'nama' | 'mrr' | 'biaya' | 'pending';
type NadaKartu = 'ok' | 'warn' | 'netral';

export function PortfolioPage() {
  const search = useSearch({ from: '/' });
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { owner } = useAuth();
  const periode = periodeValid(search.periode);
  const status = search.status ?? '';
  const q = search.q ?? '';

  const [urut, setUrut] = useState<Urut>('skor');
  const [killTarget, setKillTarget] = useState<PortfolioRow | null>(null);
  const [daftarBuka, setDaftarBuka] = useState(false);
  const [siklusBuka, setSiklusBuka] = useState(false);
  const [menuBuka, setMenuBuka] = useState<string | null>(null);

  const summaryQ = useQuery({
    queryKey: KUNCI.summary(periode),
    queryFn: ({ signal }) => api.summary(periode, signal),
  });

  const jeda = useMutation({
    mutationFn: (row: PortfolioRow) => api.jeda(row.id, !row.paused),
    onSuccess: async (_res, row) => {
      toast.sukses(`${row.nama}: ${row.paused ? 'agen dilanjutkan' : 'agen dijeda'}.`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['summary'] }),
        qc.invalidateQueries({ queryKey: ['unit'] }),
        qc.invalidateQueries({ queryKey: ['killswitch'] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
      ]);
    },
    onError: (error) => toast.galat(pesanGalat(error)),
  });

  const units = summaryQ.data?.data.units ?? [];
  const tampil = useMemo(() => {
    const cari = q.trim().toLowerCase();
    const hasil = units.filter(
      (u) => (!status || u.status === status) && (!cari || u.nama.toLowerCase().includes(cari) || u.slug.toLowerCase().includes(cari)),
    );
    const banding: Record<Urut, (a: PortfolioRow, b: PortfolioRow) => number> = {
      skor: (a, b) => (a.skor ?? 101) - (b.skor ?? 101),
      nama: (a, b) => a.nama.localeCompare(b.nama, 'id'),
      mrr: (a, b) => (b.mrr ?? -1) - (a.mrr ?? -1),
      biaya: (a, b) => b.biaya_agen_usd - a.biaya_agen_usd,
      pending: (a, b) => b.persetujuan_menunggu - a.persetujuan_menunggu,
    };
    return [...hasil].sort(banding[urut]);
  }, [units, status, q, urut]);

  const s = summaryQ.data?.data;
  // Unit kosong akan menampilkan "Belum ada SaaS Unit"; ringkasan memakai "—", bukan 0.
  const adaUnit = (s?.total ?? 0) > 0;
  const kosongAtauTidakAda = (nilai: string) => (s && !adaUnit ? '—' : nilai);

  function setFilter(patch: Partial<SearchPortofolio>) {
    void navigate({ to: '/', search: (lama) => ({ ...lama, ...patch }) });
  }

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Portofolio</h1>
          <p className="text-xs text-muted">
            {s ? `Per ${fmtTanggal(s.tanggal)} · jendela ${s.periode_hari} hari` : 'Ringkasan seluruh SaaS Unit'}
          </p>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          <Tombol ukuran="sm" onClick={() => setSiklusBuka(true)}>
            <RefreshCw className="size-3.5" aria-hidden="true" /> Siklus harian
          </Tombol>
          {owner ? (
            <Tombol ukuran="sm" varian="utama" onClick={() => setDaftarBuka(true)}>
              <Plus className="size-3.5" aria-hidden="true" /> Daftarkan SaaS
            </Tombol>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KartuRingkas label="SaaS Unit" nilai={s ? fmtAngka(s.total) : '—'} ikon={<Activity className="size-3.5" aria-hidden="true" />} />
        <KartuRingkas label="Sehat" nilai={s ? kosongAtauTidakAda(fmtAngka(s.sehat)) : '—'} nada="ok" ikon={<ArrowUpRight className="size-3.5" aria-hidden="true" />} />
        <KartuRingkas
          label="Perlu perhatian"
          nilai={s ? kosongAtauTidakAda(fmtAngka(s.perlu_perhatian)) : '—'}
          nada={s && s.perlu_perhatian > 0 ? 'warn' : 'netral'}
          ikon={<AlertTriangle className="size-3.5" aria-hidden="true" />}
        />
        <KartuRingkas label="Skor rata-rata" nilai={s ? fmtDesimal(s.skor_rata2) : '—'} ikon={<TrendingDown className="size-3.5" aria-hidden="true" />} />
        <KartuRingkas
          label="Biaya agen 30 hari"
          nilai={s ? fmtUang(s.biaya_agen_30hari_usd) : '—'}
          ikon={<CircleDollarSign className="size-3.5" aria-hidden="true" />}
        />
        <KartuRingkas
          label="Persetujuan menunggu"
          nilai={s ? kosongAtauTidakAda(fmtAngka(s.persetujuan_menunggu)) : '—'}
          nada={s && s.persetujuan_menunggu > 0 ? 'warn' : 'netral'}
          ke="/persetujuan"
        />
      </div>

      <Card>
        <CardHeader
          judul="Semua SaaS Unit"
          deskripsi={`${tampil.length} dari ${units.length} unit ditampilkan`}
          ikon={<Filter className="size-4" aria-hidden="true" />}
          aksi={
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative block">
                <span className="sr-only">Cari SaaS Unit</span>
                <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted" aria-hidden="true" />
                <Input
                  className="h-8 w-48 pl-7 text-xs"
                  placeholder="Cari nama / slug…"
                  value={q}
                  onChange={(e) => setFilter({ q: e.target.value || undefined })}
                />
              </label>
              <Select
                className="h-8 w-auto text-xs"
                aria-label="Filter status"
                value={status}
                onChange={(e) => setFilter({ status: e.target.value || undefined })}
              >
                <option value="">Semua status</option>
                {FILTER_STATUS.map((f) => (
                  <option key={f.nilai} value={f.nilai}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <div className="inline-flex overflow-hidden rounded-md border border-line" role="group" aria-label="Periode">
                {PERIODE.map((p) => (
                  <button
                    key={p.nilai}
                    type="button"
                    aria-pressed={periode === p.nilai}
                    onClick={() => setFilter({ periode: p.nilai })}
                    className={cn(
                      'px-2.5 py-1 text-xs',
                      periode === p.nilai ? 'bg-accent text-accent-fg' : 'bg-surface text-muted hover:bg-surface-2',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Select className="h-8 w-auto text-xs" aria-label="Urutkan" value={urut} onChange={(e) => setUrut(e.target.value as Urut)}>
                <option value="skor">Urut: skor (terendah)</option>
                <option value="nama">Urut: nama</option>
                <option value="mrr">Urut: MRR</option>
                <option value="biaya">Urut: biaya agen</option>
                <option value="pending">Urut: persetujuan</option>
              </Select>
            </div>
          }
        />

        {summaryQ.isError ? (
          <div className="p-3">
            <Galat error={summaryQ.error} onRetry={() => void summaryQ.refetch()} />
          </div>
        ) : null}
        {summaryQ.isLoading ? <Memuat /> : null}

        {!summaryQ.isLoading && !summaryQ.isError && units.length === 0 ? (
          <Kosong
            judul="Belum ada SaaS Unit"
            deskripsi="Jalankan npm run seed untuk data contoh, atau daftarkan SaaS Unit pertama."
            ikon={<Users className="size-6" aria-hidden="true" />}
            aksi={
              owner ? (
                <Tombol ukuran="sm" varian="utama" onClick={() => setDaftarBuka(true)}>
                  Daftarkan SaaS
                </Tombol>
              ) : null
            }
          />
        ) : null}

        {!summaryQ.isLoading && !summaryQ.isError && units.length > 0 ? (
          <Tabel>
            <thead>
              <tr>
                <th scope="col" className={kelasTh}>SaaS Unit</th>
                <th scope="col" className={kelasTh}>Status</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Health</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>MRR</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Tren MRR</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Signup</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Rating</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Biaya agen</th>
                <th scope="col" className={kelasTh}>Komponen lemah</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>
                  <span className="sr-only">Aksi</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tampil.map((u) => {
                const Tren = u.mrr_tren_persen === null ? null : u.mrr_tren_persen >= 0 ? ArrowUpRight : ArrowDownRight;
                return (
                  <tr key={u.id} className="hover:bg-surface-2/60">
                    <td className={kelasTd}>
                      <Link
                        to="/saas/$id"
                        params={{ id: u.id }}
                        search={{ periode }}
                        className="font-medium text-fg no-underline hover:text-accent"
                      >
                        {u.nama}
                      </Link>
                      <div className="text-[11px] text-muted">{u.slug}</div>
                    </td>
                    <td className={kelasTd}>
                      <div className="flex flex-wrap gap-1">
                        <Badge nada={nadaStatus(u.status)}>{u.status_label}</Badge>
                        {u.paused ? <Badge nada="warn">dijeda</Badge> : null}
                      </div>
                    </td>
                    <td className={cn(kelasTd, 'text-right')}>
                      <div className="inline-flex flex-col items-end gap-1">
                        <SkorRing skor={u.skor} ukuran={34} />
                        <span className="text-[11px] text-muted">{labelPeringkat(u.peringkat)}</span>
                      </div>
                    </td>
                    <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(u.mrr)}</td>
                    <td className={cn(kelasTd, 'tabular text-right')}>
                      <span
                        className={cn(
                          'inline-flex items-center gap-0.5',
                          u.mrr_tren_persen === null ? 'text-muted' : u.mrr_tren_persen >= 0 ? 'text-ok' : 'text-bad',
                        )}
                      >
                        {Tren ? <Tren className="size-3.5" aria-hidden="true" /> : null}
                        {fmtPersen(u.mrr_tren_persen, { tanda: true })}
                      </span>
                    </td>
                    <td className={cn(kelasTd, 'tabular text-right')}>{fmtAngka(u.signup)}</td>
                    <td className={cn(kelasTd, 'tabular text-right')}>{fmtDesimal(u.rating)}</td>
                    <td className={cn(kelasTd, 'tabular text-right')}>{fmtUang(u.biaya_agen_usd)}</td>
                    <td className={kelasTd}>
                      {u.komponen_lemah.length === 0 ? (
                        <span className="text-[11px] text-muted">—</span>
                      ) : (
                        <ul className="grid gap-1">
                          {u.komponen_lemah.map((k) => (
                            <li key={k.key} className="grid gap-0.5">
                              <span className="flex justify-between gap-2 text-[11px]">
                                <span className="text-muted">{k.label}</span>
                                <span className="tabular font-medium">{Math.round(k.score)}</span>
                              </span>
                              <Bar nilai={k.score} nada={k.score >= 70 ? 'ok' : k.score >= 55 ? 'warn' : 'bad'} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={cn(kelasTd, 'no-print text-right')}>
                      <div className="relative inline-flex items-center gap-1">
                        {u.persetujuan_menunggu > 0 ? (
                          <Link
                            to="/persetujuan"
                            search={{ saas: u.id }}
                            className="rounded-full border border-warn/40 bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn no-underline"
                            title="Lihat persetujuan unit ini"
                          >
                            {u.persetujuan_menunggu} menunggu
                          </Link>
                        ) : null}
                        <Tombol
                          ukuran="sm"
                          varian="hantu"
                          aria-label={`Aksi untuk ${u.nama}`}
                          aria-haspopup="menu"
                          aria-expanded={menuBuka === u.id}
                          onClick={() => setMenuBuka(menuBuka === u.id ? null : u.id)}
                        >
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Tombol>
                        {menuBuka === u.id ? (
                          <MenuAksi
                            row={u}
                            owner={owner}
                            onTutup={() => setMenuBuka(null)}
                            onJeda={() => {
                              setMenuBuka(null);
                              jeda.mutate(u);
                            }}
                            onKill={() => {
                              setMenuBuka(null);
                              setKillTarget(u);
                            }}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {tampil.length === 0 ? (
                <tr>
                  <td colSpan={10} className={cn(kelasTd, 'text-center text-muted')}>
                    Tidak ada unit yang cocok dengan filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </Tabel>
        ) : null}
      </Card>

      <Dialog
        terbuka={killTarget !== null}
        onTutup={() => setKillTarget(null)}
        judul={`Kill switch — ${killTarget?.nama ?? ''}`}
        deskripsi="Menghentikan agen unit ini seketika (NFR-8)."
      >
        <KillSwitchForm saasAwal={killTarget?.id} onSelesai={() => setKillTarget(null)} />
      </Dialog>

      <Dialog
        terbuka={siklusBuka}
        onTutup={() => setSiklusBuka(false)}
        judul="Jalankan siklus harian"
        deskripsi="Di produksi siklus dipicu Cron 01:00 UTC; aksi ini untuk pengujian."
        lebar="md"
      >
        <JalankanSiklus onSelesai={() => setSiklusBuka(false)} />
      </Dialog>

      {owner ? <DialogDaftarSaas terbuka={daftarBuka} onTutup={() => setDaftarBuka(false)} /> : null}
    </div>
  );
}

function KartuRingkas({
  label,
  nilai,
  nada = 'netral',
  ikon,
  ke,
}: {
  label: string;
  nilai: string;
  nada?: NadaKartu;
  ikon?: React.ReactNode;
  ke?: '/' | '/persetujuan';
}) {
  const isi = (
    <div className="rounded-card border border-line bg-surface px-3 py-2.5 transition hover:border-accent/40">
      <div className="flex items-center gap-1 text-[11px] text-muted">
        {ikon}
        {label}
      </div>
      <div className={cn('tabular mt-0.5 text-xl font-semibold', nada === 'ok' ? 'text-ok' : nada === 'warn' ? 'text-warn' : 'text-fg')}>
        {nilai}
      </div>
    </div>
  );
  if (!ke) return isi;
  return (
    <Link to={ke} className="no-underline" aria-label={`${label}: ${nilai}`}>
      {isi}
    </Link>
  );
}

function MenuAksi({
  row,
  owner,
  onTutup,
  onJeda,
  onKill,
}: {
  row: PortfolioRow;
  owner: boolean;
  onTutup: () => void;
  onJeda: () => void;
  onKill: () => void;
}) {
  const ref = useKlikLuar<HTMLDivElement>(true, onTutup);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Aksi ${row.nama}`}
      className="absolute right-0 top-8 z-20 grid w-52 gap-0.5 rounded-md border border-line bg-surface p-1 text-left shadow-lg"
    >
      <Link
        to="/saas/$id"
        params={{ id: row.id }}
        role="menuitem"
        className="rounded px-2 py-1.5 text-xs text-fg no-underline hover:bg-surface-2"
      >
        Buka detail
      </Link>
      <Link to="/audit" search={{ saas: row.id }} role="menuitem" className="rounded px-2 py-1.5 text-xs text-fg no-underline hover:bg-surface-2">
        Log audit unit
      </Link>
      {owner ? (
        <>
          <button type="button" role="menuitem" className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-2" onClick={onJeda}>
            {row.paused ? <Play className="size-3.5" aria-hidden="true" /> : <Pause className="size-3.5" aria-hidden="true" />}
            {row.paused ? 'Cabut jeda' : 'Jeda semua agen'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-bad hover:bg-bad-soft"
            onClick={onKill}
          >
            <OctagonX className="size-3.5" aria-hidden="true" /> Kill switch unit ini
          </button>
        </>
      ) : null}
    </div>
  );
}
