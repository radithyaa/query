/**
 * Health engine runtime (FR-8): mengambil metrik → menyimpan `health_evaluation`
 * → mengusulkan/menerapkan perubahan `saas_unit.status`.
 *
 * Prinsip:
 * - keputusan transisi tetap di `decideTransition` (murni, diuji);
 * - status hanya berubah lewat fungsi ini atau keputusan pemilik;
 * - transisi `intervensi → percobaan` menunggu persetujuan pemilik (`rc_plan`);
 * - `percobaan → usulan_sunset` membuat `sunset_case` berisi paket bukti.
 */
import {
  DEFAULT_TRANSITION,
  addDays,
  computeHealth,
  daysBetween,
  decideTransition,
  evaluateResurrection,
  isoDate,
  randomId,
  round,
  type AmbangConfig,
  type HealthResult,
  type SaasStatus,
} from '@portfolio/shared';
import type { SaasRecord } from '@portfolio/db';
import type { RepositoriSistem } from '../env.ts';
import { JsonStore, WORKFLOW_RC_PLAN } from './json-store.ts';
import { resolveConfig } from './config.ts';
import { ciptakanApproval, type GatewayDeps } from './gateway.ts';

export class SaasPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaasPausedError';
  }
}

export interface EvaluationOutcome {
  skor: number;
  dataCukup: boolean;
  statusBaru: SaasStatus;
  statusBerubah: boolean;
  alasan: string;
  health: HealthResult;
  /** approval `rc_plan` yang dibuat saat intervensi perlu rencana pemulihan */
  approvalRcPlan: string | null;
  /** id `sunset_case` yang dibuat saat tenggat masa percobaan lewat */
  sunsetCaseId: string | null;
}

export interface HealthEngineDeps {
  repos: RepositoriSistem;
  now?: () => number;
}

export class HealthEngine {
  private readonly repos: RepositoriSistem;
  private readonly now: () => number;
  readonly store: JsonStore;

  constructor(deps: HealthEngineDeps) {
    this.repos = deps.repos;
    this.now = deps.now ?? (() => Date.now());
    this.store = new JsonStore(deps.repos);
  }

  /**
   * Evaluasi satu SaaS Unit. `tanggal` adalah tanggal evaluasi; metrik sebelum tanggal
   * itu dipakai agar hasil dapat dihitung ulang dari data historis (kriteria Fase 3).
   */
  async evaluate(saas: SaasRecord, tanggal: string, now = this.now()): Promise<EvaluationOutcome> {
    const config = resolveConfig(saas);
    const metrics = (await this.repos.metric.list(saas.id, 90)).map((m) => m.metrik).reverse();
    const jendela = config.kriteria_bangkit.jendela_evaluasi_hari;
    const ambang: AmbangConfig = {
      pengawasan: config.ambang.pengawasan ?? DEFAULT_TRANSITION.pengawasan,
      intervensi: config.ambang.intervensi ?? DEFAULT_TRANSITION.intervensi,
      berturut: config.ambang.berturut ?? DEFAULT_TRANSITION.berturut,
      pemulihan_berturut: config.ambang.pemulihan_berturut ?? DEFAULT_TRANSITION.pemulihanBerturut,
      batas_konektor_mati_jam: config.ambang.batas_konektor_mati_jam ?? DEFAULT_TRANSITION.batasKonektorMatiJam,
    };

    const health = computeHealth({
      metrics,
      tanggal,
      ...(Object.keys(config.bobot_skor).length > 0 ? { bobot: config.bobot_skor } : {}),
      ...(Object.keys(config.skala_skor).length > 0 ? { skala: config.skala_skor } : {}),
      ambang: { pengawasan: ambang.pengawasan, intervensi: ambang.intervensi, berturut: ambang.berturut, pemulihan_berturut: ambang.pemulihan_berturut, batas_konektor_mati_jam: ambang.batas_konektor_mati_jam },
      jendelaHari: jendela,
    });

    const riwayat = await this.repos.evaluasi.history(saas.id, 4);
    const hasilSebelumnya = riwayat.map((r) => ({
      skor: r.skor,
      dataCukup: r.dataCukup,
      komponen: [],
      bobotHilang: 0,
      ambang: { pengawasan: ambang.pengawasan, intervensi: ambang.intervensi },
      alasan: [],
    })) satisfies HealthResult[];

    const konektorMatiJam = await this.konektorMatiJam(saas.id, now, ambang.batas_konektor_mati_jam);
    const kriteria = evaluateResurrection(config.kriteria_bangkit, metrics.map((m) => ({ ...m })), tanggal);
    const tenggat = typeof (config.kriteria_bangkit as unknown as Record<string, unknown>)['tenggat_iso'] === 'string'
      ? String((config.kriteria_bangkit as unknown as Record<string, unknown>)['tenggat_iso'])
      : saas.status === 'percobaan'
        ? addDays(isoDate(saas.statusSejak), config.kriteria_bangkit.masa_percobaan_hari)
        : null;

    const keputusan = decideTransition({
      statusSekarang: saas.status,
      riwayat: [health, ...hasilSebelumnya],
      dataCukup: health.dataCukup,
      skor: health.skor,
      konektorUtamaMatiJam: konektorMatiJam,
      kriteriaBangkitTercapai: kriteria.tercapai,
      tenggatLewat: tenggat !== null && daysBetween(tenggat, tanggal) > 0,
      pengecualianSunset: config.pengecualian_sunset,
      rencanaDisetujui: false,
      ambang: { pengawasan: ambang.pengawasan, intervensi: ambang.intervensi, berturut: ambang.berturut, pemulihan_berturut: ambang.pemulihan_berturut, batas_konektor_mati_jam: ambang.batas_konektor_mati_jam },
    });

    let statusBaru: SaasStatus = keputusan.type === 'tetap' ? saas.status : keputusan.ke;
    let approvalRcPlan: string | null = null;
    let sunsetCaseId: string | null = null;
    const catatan: string[] = [keputusan.alasan];
    if (kriteria.detail.length > 0) {
      catatan.push(`Kriteria bangkit: ${kriteria.detail.map((d) => `${d.metrik}=${d.nilai ?? '-'}${d.lulus ? ' ✓' : ' ✗'}`).join(', ')}`);
    }

    // intervensi tanpa rencana pemulihan → minta persetujuan pemilik (rc_plan)
    if (saas.status === 'intervensi') {
      const plan = await this.ambilPlan(saas.id);
      if (plan?.status === 'disetujui') {
        statusBaru = 'percobaan';
        catatan.push('Pemilik menyetujui rencana pemulihan; tenggat dikunci');
      } else if (!plan) {
        approvalRcPlan = await this.buatRencanaPemulihan(saas, health, kriteria.detail, now);
      }
    }

    // percobaan → usulan_sunset: buat paket bukti dan dinonaktifkan bila pengecualian aktif
    if (statusBaru === 'usulan_sunset' && !config.pengecualian_sunset) {
      sunsetCaseId = await this.buatPaketBukti(saas, health, riwayat, now);
    } else if (statusBaru === 'usulan_sunset' && config.pengecualian_sunset) {
      statusBaru = 'intervensi';
      catatan.push('Pengecualian sunset aktif: usulan sunset tidak dibuat');
    }

    await this.repos.evaluasi.save({
      saasId: saas.id,
      tanggal,
      skor: health.skor,
      komponen: health.komponen,
      dataCukup: health.dataCukup,
      statusLama: saas.status,
      statusBaru,
      alasan: catatan.join(' · '),
    });

    if (statusBaru !== saas.status) {
      await this.repos.event.emit('health.evaluated', { skor: health.skor, dari: saas.status, ke: statusBaru, alasan: catatan.join(' · ') }, { saasId: saas.id, now });
      await this.repos.audit.append({ aktor: 'sistem:health', tindakan: 'status.berubah', saasId: saas.id, masukan: { dari: saas.status, skor: health.skor }, keluaran: { ke: statusBaru, alasan: catatan.join(' · ') }, waktu: now });
    }

    return {
      skor: health.skor,
      dataCukup: health.dataCukup,
      statusBaru,
      statusBerubah: statusBaru !== saas.status,
      alasan: catatan.join(' · '),
      health,
      approvalRcPlan,
      sunsetCaseId,
    };
  }

  /** Terapkan status baru dan catat di audit (FR-8.8). */
  async applyStatus(saas: SaasRecord, status: SaasStatus, now = this.now()): Promise<void> {
    await this.repos.saas.updateStatus(saas.id, status, now);
    await this.repos.audit.append({ aktor: 'sistem:health', tindakan: 'status.berubah', saasId: saas.id, masukan: { dari: saas.status }, keluaran: { ke: status }, waktu: now });
  }

  /** Lama konektor data utama mati (jam); `null` bila sehat/tidak dikonfigurasi. */
  private async konektorMatiJam(saasId: string, now: number, batas: number): Promise<number | null> {
    const connectors = await this.repos.saas.connectors(saasId);
    const utama = connectors.filter((c) => c.utama);
    if (utama.length === 0) return null;
    const mati = utama.filter((c) => c.terakhirSehat === null || now - c.terakhirSehat > batas * 3_600_000);
    if (mati.length === 0) return null;
    const tertua = Math.min(...mati.map((c) => c.terakhirSehat ?? 0));
    return (now - tertua) / 3_600_000;
  }

  private async ambilPlan(saasId: string): Promise<{ status: string; konteks: unknown } | null> {
    return this.store.ambilWorkflow(`${WORKFLOW_RC_PLAN}:${saasId}`);
  }

  private async buatRencanaPemulihan(saas: SaasRecord, health: HealthResult, detail: Array<{ metrik: string; nilai: number | null; lulus: boolean }>, now: number): Promise<string> {
    const idemKey = `${WORKFLOW_RC_PLAN}:${saas.id}`;
    const lemah = health.komponen.filter((k) => k.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2);
    const konteks = {
      skor: health.skor,
      komponen_lemah: lemah.map((k) => ({ key: k.key, score: k.score })),
      kriteria: detail,
      langkah: lemah.map((k) => `Perbaiki ${k.label} (${k.score ?? 0}/100)`),
    };
    await this.store.menyimpanWorkflow(idemKey, saas.id, 'parent', WORKFLOW_RC_PLAN, konteks, 'menunggu_persetujuan', now);

    const dibuat = await ciptakanApproval(
      {
        approvals: this.repos.approval,
        events: this.repos.event,
        killswitch: this.repos.kill,
        loadSaas: async () => null,
        budget: async () => ({ batas: 0, terpakai: 0 }),
        rate: async () => true,
        now: () => now,
        newId: () => randomId(),
      } satisfies GatewayDeps,
      { saasId: saas.id, fungsi: 'parent', tindakan: 'buat_issue', idemKey, payload: konteks, ringkasan_dampak: `Rencana pemulihan ${saas.nama}: ${lemah.map((k) => k.label).join(', ') || 'kesehatan umum'}`, jenis_persetujuan: 'rc_plan' },
      { jenis: 'rc_plan', ringkasan: `Rencana pemulihan ${saas.nama} (skor ${health.skor})`, kedaluwarsa: now + 7 * 24 * 3_600_000 },
    );
    return dibuat.approvalId;
  }

  /** Pemilik menyetujui rencana pemulihan → status `percobaan` dan tenggat dikunci. */
  async approveRecoveryPlan(saas: SaasRecord, oleh: string, now = this.now()): Promise<void> {
    const idemKey = `${WORKFLOW_RC_PLAN}:${saas.id}`;
    await this.store.menyimpanWorkflow(idemKey, saas.id, 'parent', WORKFLOW_RC_PLAN, { disetujui_oleh: oleh }, 'disetujui', now);
    const config = resolveConfig(saas);
    const tenggat = addDays(isoDate(now), config.kriteria_bangkit.masa_percobaan_hari);
    await this.repos.saas.updateConfig(saas.id, {
      ...(saas.config as Record<string, unknown>),
      kriteria_bangkit: { ...config.kriteria_bangkit, tenggat_iso: tenggat },
    });
    await this.repos.saas.updateStatus(saas.id, 'percobaan', now);
    await this.repos.audit.append({ aktor: oleh, tindakan: 'rc_plan.disetujui', saasId: saas.id, keluaran: { status: 'percobaan', tenggat }, waktu: now });
  }

  private async buatPaketBukti(saas: SaasRecord, health: HealthResult, riwayat: Array<{ tanggal: string; skor: number }>, now: number): Promise<string> {
    const metrics = (await this.repos.metric.list(saas.id, 90)).map((m) => m.metrik).reverse();
    const awal = metrics.slice(0, 7);
    const akhir = metrics.slice(-7);
    const rataan = (list: typeof metrics, fn: (m: (typeof metrics)[number]) => number | null | undefined) => {
      const values = list.map(fn).filter((v): v is number => typeof v === 'number');
      return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 2) : null;
    };
    const pelanggan = metrics[metrics.length - 1]?.bisnis?.pelanggan_aktif ?? null;
    const biayaBulanan = rataan(metrics.slice(-30), (m) => ((m.biaya?.infra ?? 0) + (m.biaya?.agen ?? 0)) * 30 / 1000);
    const paket = {
      saas: { id: saas.id, nama: saas.nama, status: saas.status },
      skor_terakhir: health.skor,
      tren: {
        rating_awal: rataan(awal, (m) => m.toko_aplikasi?.rating_rata2),
        rating_akhir: rataan(akhir, (m) => m.toko_aplikasi?.rating_rata2),
        mrr_awal: rataan(awal, (m) => m.bisnis?.mrr),
        mrr_akhir: rataan(akhir, (m) => m.bisnis?.mrr),
      },
      riwayat_evaluasi: riwayat,
      pelanggan_berbayar: pelanggan,
      perkiraan_biaya_lanjut_bulanan: biayaBulanan,
      refund: 'Tidak ada kontrak jangka panjang pada catatan billing',
      opsi: ['lanjutkan dengan intervensi baru', 'jeda sementara', 'jual atau gabungkan ke SaaS lain', 'hentikan'],
      kriteria_bangkit: resolveConfig(saas).kriteria_bangkit,
    };
    const id = randomId();
    await this.repos.sunset.create({ id, saasId: saas.id, paketBukti: paket, tahap: 'diusulkan', dibuatPada: now });
    await this.repos.event.emit('sunset.proposed', { sunset_id: id, skor: health.skor }, { saasId: saas.id, now });
    await this.repos.notifikasi.enqueue({
      kanal: 'log',
      ke: 'pemilik',
      judul: `Usulan sunset: ${saas.nama}`,
      isi: `Masa percobaan berakhir tanpa memenuhi kriteria bangkit. Health Score ${health.skor}. Keputusan memerlukan persetujuan pemilik.`,
      now,
    });
    await this.repos.audit.append({ aktor: 'sistem:health', tindakan: 'sunset.diusulkan', saasId: saas.id, keluaran: { sunset_id: id, skor: health.skor }, waktu: now });
    return id;
  }
}
