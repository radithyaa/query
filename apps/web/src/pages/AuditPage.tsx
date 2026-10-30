/**
 * Log audit (FR-7.5, FR-7.6): setiap tindakan agen beserta masukan, keluaran,
 * dan siapa yang menyetujui; filter aktor/tindakan/tanggal/SaaS Unit (URL) dan
 * verifikasi rantai hash (NFR-11).
 *
 * Filter SaaS Unit diterapkan di klien karena `AuditQuery` server belum
 * meneruskan `saas_id`; halaman tetap berpaginasi 100 baris.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, Filter, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AuditItem } from '../lib/api';
import { api } from '../lib/api';
import { fmtTanggal, fmtWaktu } from '../lib/format';
import { KUNCI, useAudit, useSemuaUnit } from '../lib/queries';
import { rentangHari, teksValid, type SearchAudit } from '../lib/search';
import { Badge, Card, CardHeader, cn, Galat, Input, Memuat, Select, Tabel, kelasTd, kelasTh, Tombol } from '../components/ui';

const LIMIT = 100;

const TINDAKAN_CONTOH = [
  'gateway.',
  'approval.',
  'killswitch.',
  'sunset.',
  'status.berubah',
  'saas.',
  'agent.',
];

export function AuditPage() {
  const search = useSearch({ from: '/audit' });
  const navigate = useNavigate();
  const unitsQ = useSemuaUnit();

  // Filter teks disimpan lokal lalu diterapkan ke URL (debounce ringan via submit).
  const [aktor, setAktor] = useState(search.aktor ?? '');
  const [tindakan, setTindakan] = useState(search.tindakan ?? '');
  const [dari, setDari] = useState(search.dari ?? '');
  const [sampai, setSampai] = useState(search.sampai ?? '');
  const saasId = search.saas ?? '';
  const offset = Math.max(0, Number(search.offset ?? 0));

  useEffect(() => {
    // Sinkronkan state form bila URL berubah dari luar (mis. tautan dari halaman unit).
    setAktor(search.aktor ?? '');
    setTindakan(search.tindakan ?? '');
    setDari(search.dari ?? '');
    setSampai(search.sampai ?? '');
  }, [search.aktor, search.tindakan, search.dari, search.sampai]);

  const { rows, isLoading, isError, error, refetch, data } = useAudit({ aktor, tindakan, dari, sampai, saasId, offset });
  const verifyQ = useQuery({ queryKey: KUNCI.auditVerify(), queryFn: ({ signal }) => api.verifyAudit(signal), staleTime: 30_000 });
  const [terbuka, setTerbuka] = useState<number | null>(null);

  function terapkan(patch: Partial<SearchAudit>, resetOffset = true) {
    void navigate({
      to: '/audit',
      search: (lama) => {
        const baru: SearchAudit = { ...lama, ...patch };
        if (resetOffset) baru.offset = undefined;
        for (const k of Object.keys(baru) as Array<keyof SearchAudit>) {
          if (baru[k] === undefined || baru[k] === '') delete baru[k];
        }
        return baru;
      },
    });
  }

  const unitName = new Map((unitsQ.data?.data ?? []).map((u) => [u.id, u.nama]));
  const verifikasi = verifyQ.data?.data;

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Log audit</h1>
          <p className="text-xs text-muted">
            Append-only dan ber-rantai hash. Setiap masukan, keluaran, dan aktor (termasuk penyetuju) tercatat di sini.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {verifyQ.isLoading ? <Memuat label="Memverifikasi rantai…" /> : null}
          {verifikasi ? (
            verifikasi.valid ? (
              <Badge nada="ok">
                <ShieldCheck className="size-3" aria-hidden="true" /> Rantai hash valid · {verifikasi.checked} entri
              </Badge>
            ) : (
              <Badge nada="bad">
                <XCircle className="size-3" aria-hidden="true" /> Rantai rusak di #{verifikasi.rusakPada ?? '?'}
              </Badge>
            )
          ) : null}
        </div>
      </header>

      <Card>
        <CardHeader
          judul="Filter"
          ikon={<Filter className="size-4" aria-hidden="true" />}
          aksi={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="text-xs text-muted underline hover:text-fg"
                onClick={() => {
                  const r = rentangHari(7);
                  setDari(r.dari);
                  setSampai(r.sampai);
                  terapkan({ dari: r.dari, sampai: r.sampai });
                }}
              >
                7 hari terakhir
              </button>
              <button
                type="button"
                className="text-xs text-muted underline hover:text-fg"
                onClick={() => {
                  setAktor('');
                  setTindakan('');
                  setDari('');
                  setSampai('');
                  void navigate({ to: '/audit', search: {} });
                }}
              >
                Reset
              </button>
            </div>
          }
        />
        <form
          className="grid gap-2 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            terapkan({ aktor: teksValid(aktor), tindakan: teksValid(tindakan), dari: teksValid(dari), sampai: teksValid(sampai) });
          }}
        >
          <label className="grid gap-0.5 text-[11px]">
            <span className="text-muted">Aktor</span>
            <Input className="h-8 text-xs" placeholder="owner:…" value={aktor} onChange={(e) => setAktor(e.target.value)} />
          </label>
          <label className="grid gap-0.5 text-[11px]">
            <span className="text-muted">Tindakan</span>
            <Input className="h-8 text-xs" placeholder="approval." list="tindakan-contoh" value={tindakan} onChange={(e) => setTindakan(e.target.value)} />
            <datalist id="tindakan-contoh">
              {TINDAKAN_CONTOH.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="grid gap-0.5 text-[11px]">
            <span className="text-muted">SaaS Unit</span>
            <Select className="h-8 text-xs" value={saasId} onChange={(e) => terapkan({ saas: e.target.value || undefined })}>
              <option value="">Semua</option>
              {(unitsQ.data?.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nama}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-0.5 text-[11px]">
            <span className="text-muted">Dari</span>
            <Input className="h-8 text-xs" type="date" value={dari} onChange={(e) => setDari(e.target.value)} />
          </label>
          <label className="grid gap-0.5 text-[11px]">
            <span className="text-muted">Sampai</span>
            <Input className="h-8 text-xs" type="date" value={sampai} onChange={(e) => setSampai(e.target.value)} />
          </label>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
            <Tombol type="submit" ukuran="sm" varian="utama">
              Terapkan
            </Tombol>
            <span className="text-[11px] text-muted">
              {data?.filter?.dari_ms ? `Rentang UTC ${fmtTanggal(data.filter.dari_ms)} – ${fmtTanggal(data.filter.sampai_ms ?? data.filter.dari_ms)}` : 'Tanpa batas tanggal'}
            </span>
          </div>
        </form>
      </Card>

      <Card>
        {isError ? (
          <div className="p-3">
            <Galat error={error} onRetry={() => void refetch()} />
          </div>
        ) : null}
        {isLoading ? <Memuat label="Memuat entri audit…" /> : null}
        <Tabel>
          <thead>
            <tr>
              <th scope="col" className={cn(kelasTh, 'text-right')}>#</th>
              <th scope="col" className={kelasTh}>Waktu</th>
              <th scope="col" className={kelasTh}>Aktor</th>
              <th scope="col" className={kelasTh}>Tindakan</th>
              <th scope="col" className={kelasTh}>SaaS Unit</th>
              <th scope="col" className={kelasTh}>Ringkasan</th>
              <th scope="col" className={kelasTh}>
                <span className="sr-only">Detail</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <BarisAudit key={e.id} entri={e} namaUnit={unitName.get(e.saas_id ?? '')} terbuka={terbuka === e.id} onToggle={() => setTerbuka(terbuka === e.id ? null : e.id)} />
            ))}
            {!isLoading && rows.length === 0 ? (
              <tr>
                <td colSpan={7} className={cn(kelasTd, 'text-center text-muted')}>
                  {saasId && (data?.data.length ?? 0) > 0
                    ? `Tidak ada entri untuk SaaS Unit ${unitName.get(saasId) ?? saasId.slice(0, 8)} di halaman ini. Filter SaaS Unit diterapkan pada ${LIMIT} entri halaman; coba hapus filter atau pindah halaman.`
                    : 'Tidak ada entri untuk filter ini.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </Tabel>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2">
          <p className="text-[11px] text-muted">
            Menampilkan {rows.length} entri{saasId ? ' (setelah filter SaaS Unit)' : ''} dari halaman #{offset + 1}
          </p>
          <div className="flex gap-2">
            <Tombol ukuran="sm" onClick={() => terapkan({ offset: Math.max(0, offset - LIMIT) }, false)} disabled={offset === 0}>
              <ChevronLeft className="size-3.5" aria-hidden="true" /> Lebih baru
            </Tombol>
            <Tombol ukuran="sm" onClick={() => terapkan({ offset: offset + LIMIT }, false)} disabled={(data?.data.length ?? 0) < LIMIT}>
              Lebih lama <ChevronRight className="size-3.5" aria-hidden="true" />
            </Tombol>
          </div>
        </div>
      </Card>
    </div>
  );
}

function BarisAudit({
  entri,
  namaUnit,
  terbuka,
  onToggle,
}: {
  entri: AuditItem;
  namaUnit: string | undefined;
  terbuka: boolean;
  onToggle: () => void;
}) {
  const keluaran = entri.keluaran as Record<string, unknown> | null;
  const penyetuju = typeof keluaran?.['oleh'] === 'string' ? (keluaran['oleh'] as string) : null;
  const keputusan = typeof keluaran?.['keputusan'] === 'string' ? (keluaran['keputusan'] as string) : null;
  const ringkas = ringkasNilai(entri.keluaran);
  const masaPersetujuan = penyetuju ?? entri.aktor;

  return (
    <>
      <tr className="hover:bg-surface-2/60">
        <td className={cn(kelasTd, 'tabular text-right text-[11px] text-muted')}>{entri.id}</td>
        <td className={cn(kelasTd, 'whitespace-nowrap text-xs')}>{fmtWaktu(entri.waktu)}</td>
        <td className={cn(kelasTd, 'text-xs')}>{disetujuiOleh(entri)}</td>
        <td className={kelasTd}>
          <Badge nada={nadaTindakan(entri.tindakan)}>{entri.tindakan}</Badge>
        </td>
        <td className={cn(kelasTd, 'text-xs')}>{namaUnit ? <span title={entri.saas_id ?? ''}>{namaUnit}</span> : <span className="text-muted">—</span>}</td>
        <td className={cn(kelasTd, 'max-w-sm text-[11px] text-muted')}>
          {masaPersetujuan && keputusan ? `${keputusan} oleh ${masaPersetujuan} · ` : null}
          <code className="break-all">{ringkas}</code>
        </td>
        <td className={cn(kelasTd, 'text-right')}>
          <button type="button" className="text-[11px] text-accent hover:underline" onClick={onToggle} aria-expanded={terbuka}>
            {terbuka ? 'Tutup' : 'Detail'}
          </button>
        </td>
      </tr>
      {terbuka ? (
        <tr>
          <td colSpan={7} className="border-b border-line bg-surface-2/50 px-3 py-2">
            <div className="grid gap-2 text-[11px] md:grid-cols-2">
              <div>
                <p className="mb-1 font-medium text-fg">Masukan</p>
                <pre className="max-h-48 overflow-auto rounded bg-surface p-2 text-[11px]">{JSON.stringify(entri.masukan ?? null, null, 2)}</pre>
              </div>
              <div>
                <p className="mb-1 font-medium text-fg">Keluaran</p>
                <pre className="max-h-48 overflow-auto rounded bg-surface p-2 text-[11px]">{JSON.stringify(entri.keluaran ?? null, null, 2)}</pre>
              </div>
              <p className="flex items-center gap-1 text-muted md:col-span-2">
                <CheckCircle2 className="size-3" aria-hidden="true" />
                hash <code>{entri.hash.slice(0, 16)}…</code> ← sebelumnya <code>{entri.hash_sebelumnya?.slice(0, 16) ?? '—'}…</code>
              </p>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Aktor menyetujui ditampilkan di kolom aktor bila entri adalah keputusan persetujuan. */
function disetujuiOleh(entri: AuditItem): string {
  const keluaran = entri.keluaran as Record<string, unknown> | null;
  if (entri.tindakan.startsWith('approval.') && typeof keluaran?.['oleh'] === 'string') {
    return `${entri.aktor} → ${keluaran['oleh']}`;
  }
  return entri.aktor;
}

function nadaTindakan(t: string): 'ok' | 'warn' | 'bad' | 'info' | 'netral' {
  if (t.startsWith('killswitch.')) return 'bad';
  if (t.startsWith('approval.')) return 'warn';
  if (t.startsWith('gateway.')) return 'info';
  if (t === 'status.berubah' || t.startsWith('sunset.')) return 'warn';
  return 'netral';
}

function ringkasNilai(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const teks = typeof v === 'string' ? v : JSON.stringify(v);
  return teks.length > 140 ? `${teks.slice(0, 137)}…` : teks;
}
