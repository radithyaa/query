/**
 * Panel biaya (FR-7.4): pengeluaran token per fungsi/per unit terhadap anggaran
 * bulanan, plus biaya infrastruktur dari metrik harian dan status antrean/job.
 *
 * Sumber: `/portfolio/summary` (biaya agen 30 hari per unit), `/ops/metrics`
 * (total 30 hari, antrean, dead-letter), `/saas` untuk daftar unit, dan detail
 * tiap unit untuk `config.anggaran_bulanan_usd`. API belum menyediakan endpoint
 * agregat biaya terperinci, jadi angka per fungsi ditandai eksplisit.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { CircleDollarSign, Database, Server, TriangleAlert, Workflow } from 'lucide-react';
import { api, type SaasDetail } from '../lib/api';
import { fmtAngka, fmtUang, fmtWaktu } from '../lib/format';
import { KUNCI } from '../lib/queries';
import { Bar, Badge, Card, CardHeader, cn, Galat, Memuat, Tabel, kelasTd, kelasTh } from '../components/ui';

const FUNGSI = ['promosi', 'review', 'kode', 'support'] as const;

export function CostPage() {
  const summaryQ = useQuery({ queryKey: KUNCI.summary(28), queryFn: ({ signal }) => api.summary(28, signal) });
  const opsQ = useQuery({ queryKey: KUNCI.ops(), queryFn: ({ signal }) => api.ops(signal) });
  const units = summaryQ.data?.data.units ?? [];

  const detailQ = useQueries({
    queries: units.map((u) => ({
      queryKey: KUNCI.unit(u.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.unit(u.id, signal),
      staleTime: 60_000,
    })),
  });

  const detail = new Map<string, SaasDetail>();
  detailQ.forEach((r, i) => {
    const unit = units[i];
    if (unit && r.data) detail.set(unit.id, r.data.data);
  });

  const totalBudget = units.reduce((acc, u) => {
    const cfg = detail.get(u.id)?.config?.['anggaran_bulanan_usd'] as Record<string, number> | undefined;
    return acc + (cfg ? FUNGSI.reduce((a, f) => a + (cfg[f] ?? 0), 0) : 0);
  }, 0);
  const totalSpend = summaryQ.data?.data.biaya_agen_30hari_usd ?? 0;

  if (summaryQ.isError) return <Galat error={summaryQ.error} onRetry={() => void summaryQ.refetch()} />;

  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-lg font-semibold text-fg">Biaya</h1>
        <p className="text-xs text-muted">
          Pengeluaran 30 hari terhadap anggaran bulanan per SaaS Unit (FR-7.4). Peringatan pada 80% dan berhenti pada 100% ditegakkan
          policy gateway.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kartu label="Biaya agen 30 hari" nilai={fmtUang(totalSpend)} ikon={<CircleDollarSign className="size-3.5" aria-hidden="true" />} />
        <Kartu label="Anggaran bulanan (fungsi agen)" nilai={fmtUang(totalBudget)} ikon={<Database className="size-3.5" aria-hidden="true" />} />
        <Kartu
          label="Antrean job"
          nilai={opsQ.data ? fmtAngka(opsQ.data.data.antrean) : '—'}
          ikon={<Workflow className="size-3.5" aria-hidden="true" />}
          catatan={opsQ.data ? `${fmtAngka(opsQ.data.data.job_selesai_7hari)} selesai / ${fmtAngka(opsQ.data.data.job_dead_7hari)} dead (7 hari)` : undefined}
        />
        <Kartu
          label="Dead-letter"
          nilai={opsQ.data ? fmtAngka(opsQ.data.data.dead_letter) : '—'}
          ikon={<Server className="size-3.5" aria-hidden="true" />}
          nada={opsQ.data && opsQ.data.data.dead_letter > 0 ? 'bad' : undefined}
        />
      </div>

      <Card>
        <CardHeader judul="Biaya per SaaS Unit" deskripsi="Terhadap total anggaran fungsi agen per bulan" />
        {summaryQ.isLoading ? <Memuat /> : null}
        {units.length > 0 ? (
          <Tabel>
            <thead>
              <tr>
                <th scope="col" className={kelasTh}>SaaS Unit</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Biaya 30 hari</th>
                <th scope="col" className={cn(kelasTh, 'text-right')}>Anggaran/bulan</th>
                <th scope="col" className={kelasTh}>Pemakaian</th>
                <th scope="col" className={kelasTh}>Anggaran per fungsi</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u) => {
                const cfg = detail.get(u.id)?.config?.['anggaran_bulanan_usd'] as Record<string, number> | undefined;
                const anggaran = cfg ? FUNGSI.reduce((a, f) => a + (cfg[f] ?? 0), 0) : 0;
                const rasio = anggaran > 0 ? (u.biaya_agen_usd / anggaran) * 100 : 0;
                return (
                  <tr key={u.id}>
                    <td className={kelasTd}>
                      <span className="text-sm font-medium text-fg">{u.nama}</span>
                      <div className="text-[11px] text-muted">{u.slug}</div>
                    </td>
                    <td className={cn(kelasTd, 'tabular text-right')}>{fmtUang(u.biaya_agen_usd)}</td>
                    <td className={cn(kelasTd, 'tabular text-right')}>{anggaran > 0 ? fmtUang(anggaran) : '—'}</td>
                    <td className={kelasTd}>
                      {anggaran > 0 ? (
                        <div className="grid gap-1">
                          <span className="tabular text-[11px]">{Math.round(rasio)}%</span>
                          <Bar nilai={rasio} nada={rasio >= 100 ? 'bad' : rasio >= 80 ? 'warn' : 'ok'} />
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted">tidak ditetapkan</span>
                      )}
                    </td>
                    <td className={kelasTd}>
                      <div className="flex flex-wrap gap-1">
                        {cfg
                          ? FUNGSI.filter((f) => cfg[f] !== undefined).map((f) => (
                              <Badge key={f}>
                                {f} ${cfg[f]}
                              </Badge>
                            ))
                          : null}
                        {!cfg ? <span className="text-[11px] text-muted">—</span> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Tabel>
        ) : null}
      </Card>

      <Card className="p-3">
        <p className="flex items-start gap-2 text-[11px] text-muted">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Rincian biaya per <em>fungsi</em> (token model, render, iklan) belum diekspos API publik; angka di atas adalah total biaya
            agen per unit dari `agent_run.biaya_usd`. Anggaran per fungsi dibaca dari konfigurasi unit dan ditegakkan policy gateway.
            Diperbarui {fmtWaktu(Date.now())}.
          </span>
        </p>
      </Card>
    </div>
  );
}

function Kartu({ label, nilai, ikon, catatan, nada }: { label: string; nilai: string; ikon?: React.ReactNode; catatan?: string; nada?: 'bad' }) {
  return (
    <div className="rounded-card border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1 text-[11px] text-muted">
        {ikon}
        {label}
      </div>
      <div className={cn('tabular mt-0.5 text-xl font-semibold', nada === 'bad' ? 'text-bad' : 'text-fg')}>{nilai}</div>
      {catatan ? <div className="text-[11px] text-muted">{catatan}</div> : null}
    </div>
  );
}
