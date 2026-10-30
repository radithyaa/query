/**
 * Data halaman portofolio (FR-7.1, FR-7.4, FR-7.6): Health Score terakhir, status,
 * tren MRR/signup/rating, biaya agen, dan ringkasan antrean persetujuan.
 *
 * Satu kueri metrik untuk semua SaaS Unit (`latestForAll`) dan satu kueri
 * evaluasi terakhir, sehingga memenuhi target muat 3 detik untuk 50 unit (NFR-9).
 */
import {
  KOMPONEN_LABELS,
  STATUS_LABELS,
  computeHealth,
  isoDate,
  periodeBulan,
  round,
  type HealthResult,
} from '@portfolio/shared';
import type { RepositoriSistem } from '../env.ts';
import { resolveConfig } from '../orchestrator/config.ts';

export interface PortfolioRow {
  id: string;
  slug: string;
  nama: string;
  status: string;
  status_label: string;
  paused: boolean;
  skor: number | null;
  data_cukup: boolean;
  komponen_lemah: Array<{ key: string; label: string; score: number }>;
  mrr: number | null;
  mrr_tren_persen: number | null;
  signup: number | null;
  rating: number | null;
  biaya_agen_usd: number;
  persetujuan_menunggu: number;
  peringkat: 'sehat' | 'pengawasan' | 'kritis' | 'tidak_diketahui';
}

export interface PortfolioSummary {
  tanggal: string;
  periode_hari: number;
  total: number;
  sehat: number;
  perlu_perhatian: number;
  skor_rata2: number | null;
  biaya_agen_30hari_usd: number;
  persetujuan_menunggu: number;
  units: PortfolioRow[];
}

function peringkat(skor: number | null, dataCukup: boolean): PortfolioRow['peringkat'] {
  if (skor === null || !dataCukup) return 'tidak_diketahui';
  if (skor >= 70) return 'sehat';
  if (skor >= 55) return 'pengawasan';
  return 'kritis';
}

export async function portfolioSummary(
  repos: RepositoriSistem,
  opts: { periode?: number; now?: number; hanya?: string[] | null } = {},
): Promise<PortfolioSummary> {
  const now = opts.now ?? Date.now();
  const periode = opts.periode ?? 28;
  const units = (await repos.saas.all({ limit: 500 })).filter((u) => u.slug !== 'portofolio' && (!opts.hanya || opts.hanya.includes(u.id)));
  const metrics = await repos.metric.latestForAll(units.map((u) => u.id), periode + 1);
  const biaya = await repos.db
    .prepare(
      `SELECT j.saas_id AS saas_id, SUM(r.biaya_usd) AS total
       FROM agent_run r JOIN agent_job j ON j.id = r.job_id
       WHERE r.mulai > ? GROUP BY j.saas_id`,
    )
    .bind(now - 30 * 86_400_000)
    .all<{ saas_id: string; total: number | null }>();
  const biayaMap = new Map(biaya.results.map((r) => [r.saas_id, Number(r.total ?? 0)]));
  const pending = await repos.db.prepare("SELECT saas_id, COUNT(*) AS n FROM approval WHERE status = 'menunggu' GROUP BY saas_id").all<{ saas_id: string; n: number }>();
  const pendingMap = new Map(pending.results.map((r) => [r.saas_id, Number(r.n)]));

  const rows: PortfolioRow[] = [];
  for (const unit of units) {
    const serie = (metrics.get(unit.id) ?? []).map((m) => m.metrik).reverse();
    const terbaru = serie[serie.length - 1];
    const config = resolveConfig(unit);
    const lastEval = await repos.evaluasi.latest(unit.id);
    const health: HealthResult | null =
      serie.length > 0
        ? computeHealth({
            metrics: serie,
            ...(lastEval ? { tanggal: lastEval.tanggal } : {}),
            jendelaHari: config.kriteria_bangkit.jendela_evaluasi_hari,
          })
        : null;
    const skor = lastEval?.skor ?? health?.skor ?? null;
    const dataCukup = lastEval?.dataCukup ?? health?.dataCukup ?? false;
    const mrrAwal = serie[0]?.bisnis?.mrr ?? null;
    const mrrAkhir = terbaru?.bisnis?.mrr ?? null;
    rows.push({
      id: unit.id,
      slug: unit.slug,
      nama: unit.nama,
      status: unit.status,
      status_label: STATUS_LABELS[unit.status],
      paused: unit.paused,
      skor,
      data_cukup: dataCukup,
      komponen_lemah: (health?.komponen ?? [])
        .filter((k) => k.score !== null)
        .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
        .slice(0, 2)
        .map((k) => ({ key: k.key, label: KOMPONEN_LABELS[k.key as keyof typeof KOMPONEN_LABELS] ?? k.key, score: k.score ?? 0 })),
      mrr: mrrAkhir,
      mrr_tren_persen: mrrAwal !== null && mrrAkhir !== null && mrrAwal > 0 ? round(((mrrAkhir - mrrAwal) / mrrAwal) * 100, 2) : null,
      signup: terbaru?.bisnis?.signup_baru ?? null,
      rating: terbaru?.toko_aplikasi?.rating_rata2 ?? null,
      biaya_agen_usd: round(biayaMap.get(unit.id) ?? 0, 4),
      persetujuan_menunggu: pendingMap.get(unit.id) ?? 0,
      peringkat: peringkat(skor, dataCukup),
    });
  }

  rows.sort((a, b) => (a.skor ?? 101) - (b.skor ?? 101));
  const skorValid = rows.map((r) => r.skor).filter((s): s is number => s !== null);
  return {
    tanggal: isoDate(now),
    periode_hari: periode,
    total: rows.length,
    sehat: rows.filter((r) => r.peringkat === 'sehat').length,
    perlu_perhatian: rows.filter((r) => r.peringkat === 'kritis' || r.peringkat === 'pengawasan').length,
    skor_rata2: skorValid.length ? round(skorValid.reduce((a, b) => a + b, 0) / skorValid.length, 1) : null,
    biaya_agen_30hari_usd: round([...biayaMap.values()].reduce((a, b) => a + b, 0), 4),
    persetujuan_menunggu: [...pendingMap.values()].reduce((a, b) => a + b, 0),
    units: rows,
  };
}

export { periodeBulan };
