/**
 * Health engine (FR-8): komponen skor murni tanpa I/O sehingga dapat diuji
 * deterministik dan dihitung ulang dari data historis (kriteria Fase 3).
 *
 * Tipe input di bawah adalah bentuk konfigurasi per SaaS Unit (lihat §11.1):
 * `bobot_skor`, `skala_skor`, `ambang`.
 */
import {
  DEFAULT_SKALA,
  DEFAULT_TRANSITION,
  KOMPONEN,
  KOMPONEN_INVERS,
  KOMPONEN_LABELS,
  type SaasStatus,
  type SkalaKomponen,
} from './constants.ts';
import type { DailyMetric } from './schemas.ts';
import { clamp, daysBetween, mergeDefined, round } from './util.ts';

export interface BobotSkor {
  pendapatan: number;
  retensi: number;
  pengguna: number;
  kepuasan: number;
  stabilitas: number;
  biaya: number;
}

export type SkalaSkor = Record<keyof BobotSkor, SkalaKomponen>;

export interface AmbangConfig {
  pengawasan: number;
  intervensi: number;
  berturut: number;
  pemulihan_berturut: number;
  batas_konektor_mati_jam: number;
}

export interface KriteriaBangkit {
  jendela_evaluasi_hari: number;
  masa_percobaan_hari: number;
  syarat: Array<{
    metrik: 'pertumbuhan_mrr_persen' | 'rating_rata2' | 'churn_bulanan_persen' | 'mrr' | 'aktivasi_persen';
    minimal?: number;
    maksimal?: number;
  }>;
}

export interface HealthComponentScore {
  key: string;
  label: string;
  raw: number | null;
  score: number | null;
  weight: number;
  weightUsed: number;
}

export interface HealthResult {
  skor: number;
  komponen: HealthComponentScore[];
  dataCukup: boolean;
  bobotHilang: number;
  ambang: { pengawasan: number; intervensi: number };
  alasan: string[];
}

export interface HealthInput {
  metrics: DailyMetric[];
  /** Bila diberikan, hanya metrik sebelum tanggal ini (riwayat) yang dipakai. */
  tanggal?: string;
  bobot?: Partial<BobotSkor>;
  skala?: Partial<SkalaSkor>;
  ambang?: Partial<AmbangConfig>;
  /** jendela evaluasi dalam hari (default 28) */
  jendelaHari?: number;
  /** MRR akhir bulan sebelumnya untuk komponen pertumbuhan (opsional) */
  pendapatanBulanLalu?: number;
}

const RENTANG_JENDELA = DEFAULT_TRANSITION.jendelaHari;

interface WindowValues {
  mrrAwal: number | null;
  mrrAkhir: number | null;
  churn: number | null;
  retensiD30: number | null;
  signup: number | null;
  mau: number | null;
  aktivasi: number | null;
  rating: number | null;
  ulasanNegatif: number | null;
  ulasanTotal: number | null;
  errorRate: number | null;
  uptime: number | null;
  biayaInfra: number | null;
  biayaAgen: number | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function avg(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function sum(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

/**
 * Normalisasi 0..100 terhadap (min, target) mengikuti rumus §4.8.
 * Untuk komponen invers (churn, rasio biaya) `min` adalah nilai terbaik.
 */
export function normalize(raw: number, skala: SkalaKomponen, invers = false): number {
  const { min, target } = skala;
  if (target === min) return raw >= target ? 100 : 0;
  const ratio = invers ? (min - raw) / (min - target) : (raw - min) / (target - min);
  return clamp(ratio * 100, 0, 100);
}

/** Petakan konfigurasi ambang (snake_case §11.1) ke bentuk internal. */
function resolveAmbang(override?: Partial<AmbangConfig>): typeof DEFAULT_TRANSITION {
  const merged = mergeDefined(DEFAULT_TRANSITION, {
    pengawasan: override?.pengawasan,
    intervensi: override?.intervensi,
    berturut: override?.berturut,
    pemulihanBerturut: override?.pemulihan_berturut,
    batasKonektorMatiJam: override?.batas_konektor_mati_jam,
  } as Partial<typeof DEFAULT_TRANSITION>);
  return merged;
}

function windowValues(metrics: DailyMetric[], input: HealthInput, jendelaHari = RENTANG_JENDELA): WindowValues {
  const sorted = [...metrics]
    .filter((m) => !input.tanggal || m.tanggal < input.tanggal)
    .sort((a, b) => a.tanggal.localeCompare(b.tanggal));
  const empty: WindowValues = {
    mrrAwal: null,
    mrrAkhir: null,
    churn: null,
    retensiD30: null,
    signup: null,
    mau: null,
    aktivasi: null,
    rating: null,
    ulasanNegatif: null,
    ulasanTotal: null,
    errorRate: null,
    uptime: null,
    biayaInfra: null,
    biayaAgen: null,
  };
  if (sorted.length === 0) return empty;

  const windowEnd = sorted[sorted.length - 1]!.tanggal;
  const windowStart = sorted.find((m) => daysBetween(m.tanggal, windowEnd) <= jendelaHari - 1)?.tanggal ?? windowEnd;
  const inWindow = sorted.filter((m) => m.tanggal >= windowStart && m.tanggal <= windowEnd);
  const last = sorted[sorted.length - 1]!;
  const lastWeek = inWindow.slice(-7);

  const mrrSeries = inWindow.map((m) => num(m.bisnis?.mrr)).filter((v): v is number => v !== null);
  const mrrAkhir = num(last.bisnis?.mrr);
  const mrrAwal = input.pendapatanBulanLalu ?? mrrSeries[0] ?? null;

  const churn = avg(lastWeek.map((m) => num(m.bisnis?.churn_bulanan_persen)));

  return {
    mrrAwal,
    mrrAkhir,
    churn,
    retensiD30: churn !== null ? clamp(100 - churn, 0, 100) : null,
    signup: sum(inWindow.map((m) => num(m.bisnis?.signup_baru))),
    mau: avg(inWindow.map((m) => num(m.produk?.mau))),
    aktivasi: avg(inWindow.map((m) => num(m.produk?.aktivasi_persen))),
    rating: avg(inWindow.map((m) => num(m.toko_aplikasi?.rating_rata2))),
    ulasanNegatif: sum(inWindow.map((m) => num(m.toko_aplikasi?.ulasan_negatif))),
    ulasanTotal: sum(inWindow.map((m) => num(m.toko_aplikasi?.ulasan_baru))),
    errorRate: avg(lastWeek.map((m) => num(m.stabilitas?.error_rate_persen))),
    uptime: avg(lastWeek.map((m) => num(m.stabilitas?.uptime_persen))),
    biayaInfra: sum(inWindow.map((m) => num(m.biaya?.infra))),
    biayaAgen: sum(inWindow.map((m) => num(m.biaya?.agen))),
  };
}

function componentRaw(
  key: keyof BobotSkor,
  w: WindowValues,
): { raw: number | null; invers: boolean } {
  switch (key) {
    case 'pendapatan': {
      if (w.mrrAwal === null || w.mrrAkhir === null || w.mrrAwal <= 0) return { raw: null, invers: false };
      return { raw: ((w.mrrAkhir - w.mrrAwal) / w.mrrAwal) * 100, invers: false };
    }
    case 'retensi': {
      // churn bulanan sebagai proksi retensi; retensi D30 dipakai bila churn tidak ada
      if (w.churn !== null) return { raw: w.churn, invers: true };
      if (w.retensiD30 !== null) return { raw: 100 - w.retensiD30, invers: true };
      return { raw: null, invers: false };
    }
    case 'pengguna': {
      if (w.signup !== null && w.mau !== null && w.mau > 0) return { raw: (w.signup / w.mau) * 100, invers: false };
      return { raw: w.aktivasi, invers: false };
    }
    case 'kepuasan': {
      if (w.rating === null) return { raw: null, invers: false };
      const negRatio = w.ulasanNegatif !== null && w.ulasanTotal !== null && w.ulasanTotal > 0 ? w.ulasanNegatif / w.ulasanTotal : 0;
      return { raw: w.rating - negRatio, invers: false };
    }
    case 'stabilitas': {
      if (w.errorRate === null && w.uptime === null) return { raw: null, invers: false };
      if (w.uptime === null) return { raw: 100 - w.errorRate!, invers: false };
      return { raw: w.uptime - (w.errorRate ?? 0) * 0.5, invers: false };
    }
    case 'biaya': {
      if (w.mrrAkhir === null || w.mrrAkhir <= 0) return { raw: null, invers: false };
      const total = (w.biayaInfra ?? 0) + (w.biayaAgen ?? 0);
      return { raw: (total / w.mrrAkhir) * 100, invers: true };
    }
  }
}

export function defaultBobot(): BobotSkor {
  return { pendapatan: 25, retensi: 20, pengguna: 15, kepuasan: 15, stabilitas: 15, biaya: 10 };
}

/** Hitung Health Score menurut §4.8; metrik kosong dikeluarkan dan bobot dinormalkan ulang. */
export function computeHealth(input: HealthInput): HealthResult {
  const bobot = mergeDefined(defaultBobot(), input.bobot);
  const skala = mergeDefined<SkalaSkor>({ ...DEFAULT_SKALA }, input.skala as Partial<SkalaSkor> | undefined);
  const ambang = resolveAmbang(input.ambang);
  const jendelaHari = input.jendelaHari ?? RENTANG_JENDELA;
  const values = windowValues(input.metrics, input, jendelaHari);

  const totalBobot = KOMPONEN.reduce((acc, k) => acc + (bobot[k] ?? 0), 0) || 1;
  const komponen: HealthComponentScore[] = [];
  const alasan: string[] = [];
  let bobotHilang = 0;

  for (const key of KOMPONEN) {
    const weight = bobot[key] ?? 0;
    const { raw, invers } = componentRaw(key, values);
    const useInvers = invers || KOMPONEN_INVERS.has(key);
    const skalaKey = skala[key] ?? DEFAULT_SKALA[key];
    const score = raw === null ? null : round(normalize(raw, skalaKey, useInvers), 2);
    if (score === null) {
      bobotHilang += weight;
      alasan.push(`Komponen ${KOMPONEN_LABELS[key]} tidak tersedia`);
    }
    komponen.push({
      key,
      label: KOMPONEN_LABELS[key],
      raw: raw === null ? null : round(raw, 2),
      score,
      weight,
      weightUsed: 0,
    });
  }

  const bobotTersedia = komponen.filter((k) => k.score !== null).reduce((acc, k) => acc + k.weight, 0);
  if (bobotTersedia <= 0) {
    return {
      skor: 0,
      komponen,
      dataCukup: false,
      bobotHilang: totalBobot,
      ambang: { pengawasan: ambang.pengawasan, intervensi: ambang.intervensi },
      alasan: ['Tidak ada metrik yang dapat dipakai'],
    };
  }

  let skor = 0;
  for (const k of komponen) {
    if (k.score === null) continue;
    k.weightUsed = round((k.weight / bobotTersedia) * 100, 2);
    skor += (k.score * k.weight) / bobotTersedia;
  }

  const dataCukup = bobotHilang <= totalBobot / 3;
  if (!dataCukup) alasan.push('Lebih dari sepertiga bobot hilang: data tidak cukup, status tidak diturunkan');

  return {
    skor: round(clamp(skor, 0, 100), 2),
    komponen,
    dataCukup,
    bobotHilang: round(bobotHilang, 2),
    ambang: { pengawasan: ambang.pengawasan, intervensi: ambang.intervensi },
    alasan,
  };
}

export type TransitionOutcome =
  | { type: 'tetap'; alasan: string }
  | { type: 'turun'; ke: SaasStatus; alasan: string }
  | { type: 'naik'; ke: SaasStatus; alasan: string };

export interface TransitionContext {
  statusSekarang: SaasStatus;
  /** hasil evaluasi sebelumnya, terbaru lebih dulu */
  riwayat: HealthResult[];
  dataCukup: boolean;
  skor: number;
  konektorUtamaMatiJam: number | null;
  kriteriaBangkitTercapai: boolean;
  tenggatLewat: boolean;
  pengecualianSunset: boolean;
  rencanaDisetujui: boolean;
  ambang?: Partial<AmbangConfig>;
}

/**
 * Tabel transisi FR-8 (nilai awal yang dapat diubah). Status hanya berubah lewat
 * Health engine atau keputusan pemilik; fungsi ini murni dan deterministik.
 */
export function decideTransition(ctx: TransitionContext): TransitionOutcome {
  const ambang = resolveAmbang(ctx.ambang);

  if (ctx.konektorUtamaMatiJam !== null && ctx.konektorUtamaMatiJam > ambang.batasKonektorMatiJam) {
    return { type: 'tetap', alasan: `Konektor data utama mati ${Math.round(ctx.konektorUtamaMatiJam)} jam: evaluasi ditahan` };
  }
  if (!ctx.dataCukup) {
    return { type: 'tetap', alasan: 'Data tidak cukup untuk mengevaluasi' };
  }

  const diBawah = (limit: number, count: number): boolean => {
    const relevant = ctx.riwayat.filter((r) => r.dataCukup).slice(0, count);
    if (relevant.length < count) return false;
    return relevant.every((r) => r.skor < limit);
  };

  const pulih = ctx.kriteriaBangkitTercapai;

  switch (ctx.statusSekarang) {
    case 'aktif':
      if (diBawah(ambang.pengawasan, ambang.berturut)) {
        return {
          type: 'turun',
          ke: 'pengawasan',
          alasan: `Health Score di bawah ${ambang.pengawasan} pada ${ambang.berturut} evaluasi berturut-turut`,
        };
      }
      return { type: 'tetap', alasan: 'Kesehatan dalam batas' };

    case 'pengawasan':
      if (pulih) return { type: 'naik', ke: 'aktif', alasan: 'Kriteria bangkit tercapai' };
      if (diBawah(ambang.intervensi, ambang.berturut)) {
        return {
          type: 'turun',
          ke: 'intervensi',
          alasan: `Health Score di bawah ${ambang.intervensi} pada ${ambang.berturut} evaluasi berturut-turut`,
        };
      }
      return { type: 'tetap', alasan: 'Menunggu perkembangan' };

    case 'intervensi':
      if (pulih) return { type: 'naik', ke: 'aktif', alasan: 'Kriteria bangkit tercapai' };
      if (ctx.rencanaDisetujui) {
        return { type: 'naik', ke: 'percobaan', alasan: 'Pemilik menyetujui rencana pemulihan; tenggat dikunci' };
      }
      return { type: 'tetap', alasan: 'Menunggu persetujuan rencana pemulihan' };

    case 'percobaan':
      if (pulih) return { type: 'naik', ke: 'aktif', alasan: 'Kriteria bangkit tercapai; ringkasan pemulihan disusun' };
      if (ctx.tenggatLewat) {
        return { type: 'turun', ke: 'usulan_sunset', alasan: 'Tenggat masa percobaan lewat tanpa kriteria bangkit' };
      }
      return { type: 'tetap', alasan: 'Masa percobaan berjalan' };

    case 'usulan_sunset':
      return { type: 'tetap', alasan: 'Menunggu keputusan pemilik (sunset tidak otonom)' };

    default:
      return { type: 'tetap', alasan: `Status ${ctx.statusSekarang} tidak dievaluasi otomatis` };
  }
}

export interface ResurrectionDetail {
  metrik: string;
  nilai: number | null;
  minimal?: number;
  maksimal?: number;
  lulus: boolean;
}

/** Evaluasi kriteria bangkit terhadap metrik 28 hari; true bila SEMUA syarat terpenuhi. */
export function evaluateResurrection(
  kriteria: KriteriaBangkit,
  metrics: DailyMetric[],
  tanggal?: string,
): { tercapai: boolean; detail: ResurrectionDetail[] } {
  const sorted = [...metrics]
    .filter((m) => !tanggal || m.tanggal < tanggal)
    .sort((a, b) => a.tanggal.localeCompare(b.tanggal));
  const end = sorted[sorted.length - 1];
  const startMark = end ? sorted.find((m) => daysBetween(m.tanggal, end.tanggal) <= kriteria.jendela_evaluasi_hari - 1) : undefined;
  const jendela = startMark ? sorted.filter((m) => m.tanggal >= startMark.tanggal) : sorted;

  const mrrFirst = jendela.map((m) => m.bisnis?.mrr).find((v): v is number => typeof v === 'number');
  const mrrLast = [...jendela]
    .reverse()
    .map((m) => m.bisnis?.mrr)
    .find((v): v is number => typeof v === 'number');
  const churnAvg = avg(jendela.map((m) => m.bisnis?.churn_bulanan_persen));
  const aktivasiAvg = avg(jendela.map((m) => m.produk?.aktivasi_persen));
  const ratingWeighted = (() => {
    const pairs = jendela
      .map((m) => ({ r: m.toko_aplikasi?.rating_rata2, n: m.toko_aplikasi?.ulasan_baru ?? 1 }))
      .filter((p): p is { r: number; n: number } => typeof p.r === 'number');
    if (pairs.length === 0) return null;
    const totalN = pairs.reduce((a, b) => a + b.n, 0) || pairs.length;
    return pairs.reduce((a, b) => a + b.r * b.n, 0) / totalN;
  })();

  const nilai: Record<string, number | null> = {
    pertumbuhan_mrr_persen:
      mrrFirst !== undefined && mrrLast !== undefined && mrrFirst > 0 ? ((mrrLast - mrrFirst) / mrrFirst) * 100 : null,
    rating_rata2: ratingWeighted,
    churn_bulanan_persen: churnAvg,
    mrr: mrrLast ?? null,
    aktivasi_persen: aktivasiAvg,
  };

  const detail: ResurrectionDetail[] = kriteria.syarat.map((s) => {
    const v = nilai[s.metrik] ?? null;
    const lulusMin = s.minimal === undefined || (v !== null && v >= s.minimal);
    const lulusMax = s.maksimal === undefined || (v !== null && v <= s.maksimal);
    const item: ResurrectionDetail = { metrik: s.metrik, nilai: v === null ? null : round(v, 2), lulus: v !== null && lulusMin && lulusMax };
    if (s.minimal !== undefined) item.minimal = s.minimal;
    if (s.maksimal !== undefined) item.maksimal = s.maksimal;
    return item;
  });

  return { tercapai: detail.length > 0 && detail.every((d) => d.lulus), detail };
}
