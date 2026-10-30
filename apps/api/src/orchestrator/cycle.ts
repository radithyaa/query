/**
 * Orkestrator siklus harian (§3.3, §3.7).
 *
 * Urutan satu siklus:
 *   1. pulihkan job macet + tandai persetujuan kedaluwarsa;
 *   2. untuk tiap SaaS Unit: tarik metrik dari konektor (bila belum ada),
 *      jadwalkan job agen unit, lalu evaluasi Health Score dan transisi status;
 *   3. jalankan job agen satu per satu lewat antrean persisten;
 *   4. Agen Induk menyusun laporan harian portofolio.
 *
 * Semua langkah idempoten (`saas:fungsi:jenis:tanggal`) sehingga aman diulang.
 * Setiap perubahan status, keputusan gateway, dan kegagalan job tercatat di
 * `audit_log` (NFR-11).
 */
import {
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_JOB_BATAS,
  PROMPT_VERSI,
  addDays,
  computeHealth,
  isoDate,
  isoWeek,
  periodeBulan,
  randomId,
  type ApprovalJenis,
  type Fungsi,
  type JobJenis,
  type SaasConfigResolved,
  type SaasStatus,
  type SunsetTahap,
  type DailyMetric,
} from '@portfolio/shared';
import { createConnectors, type ConnectorSet } from '@portfolio/connectors';
import {
  AnthropicClient,
  MockPlanModel,
  jalankanKode,
  jalankanParent,
  jalankanPromosi,
  jalankanReview,
  jalankanSupport,
  type AgentOutcome,
  type AgentRuntime,
  type KeluaranKode,
  type KeluaranPromosi,
  type ModelClient,
  type SaasSnapshot,
  type ToolContext,
} from '@portfolio/agents';
import { DailyMetric as DailyMetricSchema, type GatewayCheckRequest, type GatewayDecision } from '@portfolio/shared';
import type { SaasRecord } from '@portfolio/db';
import type { Bindings, RepositoriSistem } from '../env.ts';
import { buatGuard, isMock } from '../env.ts';
import type { GuardLike } from '../do/guard.ts';
import { evaluateGateway, type GatewayDeps } from './gateway.ts';
import { SaasPausedError, type HealthEngine } from './health.ts';
import { resolveConfig } from './config.ts';
import { TOPIC_JOB, backoffMs } from './queue.ts';

export interface RunCycleOptions {
  /** tanggal siklus; default hari ini (UTC). Test memakai tanggal tetap. */
  tanggal?: string;
  /** true: hanya menyiapkan job + evaluasi, tanpa menjalankan agen */
  skipJobs?: boolean;
  /** paksa tarik metrik walau sudah ada */
  refreshMetrics?: boolean;
  now?: number;
}

export type JobRingkas = { id: string; saasId: string; fungsi: Fungsi; jenis: JobJenis; status: string; approvalId: string | null; alasan: string };

export interface CycleResult {
  tanggal: string;
  metricsIngested: string[];
  metricsSkipped: string[];
  jobsQueued: string[];
  jobsSkipped: string[];
  evaluations: Array<{ saasId: string; skor: number; dari: SaasStatus; ke: SaasStatus; alasan: string }>;
  jobs: JobRingkas[];
  reports: string[];
  deadLetter: number;
}

export interface OrchestratorDeps {
  db: Bindings['DB'];
  repos: RepositoriSistem;
  env: Bindings;
  model?: ModelClient;
  connectors?: ConnectorSet;
  now?: () => number;
  /** TTL permintaan persetujuan (ms) */
  ttlMs?: number;
  /** override guard (test); default dipilih `buatGuard` dari binding */
  guard?: GuardLike;
}

const JENIS_HARIAN = {
  review: 'review_harian',
  support: 'support_harian',
  promosi: 'promosi_harian',
  kode: 'kode_harian',
} as const satisfies Partial<Record<Fungsi, JobJenis>>;

export function jobIdemKey(saasId: string, fungsi: Fungsi, jenis: JobJenis, tanggal: string): string {
  return `${saasId}:${fungsi}:${jenis}:${tanggal}`;
}

export class Orchestrator {
  readonly deps: OrchestratorDeps;
  readonly health: HealthEngine;
  readonly connectors: ConnectorSet;
  readonly model: ModelClient;
  private readonly clock: () => number;
  private readonly gateway: GatewayDeps;
  /** Satu penulis untuk kill switch/anggaran/rate limit (§3.2): DO di Workers, tabel di Node. */
  readonly guard: GuardLike;

  constructor(deps: OrchestratorDeps, health: HealthEngine) {
    this.deps = deps;
    this.health = health;
    this.clock = deps.now ?? (() => Date.now());
    this.guard = deps.guard ?? buatGuard(deps.env, async () => (await deps.repos.kill.state()).global);
    this.connectors = deps.connectors ?? createConnectors({ mode: isMock(deps.env) ? 'mock' : 'http' });
    this.model =
      deps.model ??
      (deps.env.ANTHROPIC_API_KEY ? new AnthropicClient({ apiKey: deps.env.ANTHROPIC_API_KEY }) : new MockPlanModel());
    this.gateway = this.gatewayDeps();
  }

  get repos(): RepositoriSistem {
    return this.deps.repos;
  }

  // ------------------------------------------------------------------ siklus

  async runCycle(opts: RunCycleOptions = {}): Promise<CycleResult> {
    const now = opts.now ?? this.clock();
    const tanggal = opts.tanggal ?? isoDate(now);
    const result: CycleResult = {
      tanggal,
      metricsIngested: [],
      metricsSkipped: [],
      jobsQueued: [],
      jobsSkipped: [],
      evaluations: [],
      jobs: [],
      reports: [],
      deadLetter: 0,
    };

    await this.repos.job.recoverStuck(now - DEFAULT_JOB_BATAS.timeout_ms * 4);
    await this.repos.approval.expireDue(now);

    const kill = await this.repos.kill.state();
    const units = await this.repos.saas.all({ limit: 500 });

    for (const unit of units) {
      if (unit.slug === 'portofolio') continue;
      const ingest = await this.ingestMetrics(unit, tanggal, now, opts.refreshMetrics ?? false);
      (ingest === 'baru' ? result.metricsIngested : result.metricsSkipped).push(unit.id);

      const config = resolveConfig(unit);
      const paused = unit.paused || kill.global || Boolean(kill.perSaas.get(unit.id)?.aktif);
      const bolehJalan = !paused && (['aktif', 'pengawasan', 'intervensi', 'percobaan'] as SaasStatus[]).includes(unit.status);

      if (bolehJalan) {
        for (const fungsi of config.fungsi_aktif) {
          const jenis = JENIS_HARIAN[fungsi as keyof typeof JENIS_HARIAN];
          if (!jenis) continue;
          const queued = await this.queueJob(unit.id, fungsi, jenis, tanggal, now);
          if (queued.baru) result.jobsQueued.push(queued.id);
          else result.jobsSkipped.push(queued.id);
        }
        const mingguan = await this.queueJob(unit.id, 'promosi', 'promosi_mingguan', isoWeek(now), now);
        if (mingguan.baru) result.jobsQueued.push(mingguan.id);
      }

      const evaluasi = await this.evaluateUnit(unit, tanggal, now);
      if (evaluasi) result.evaluations.push(evaluasi);
    }

    if (!opts.skipJobs) result.jobs = await this.consumeJobs({ jumlah: 200, now });

    const laporan = await this.parentReport(tanggal, now);
    if (laporan) result.reports.push(laporan);

    result.deadLetter = await this.repos.queue.deadLetterSize();
    return result;
  }

  // ------------------------------------------------------------------ metrik

  /**
   * Tarik metrik harian dari konektor billing/analytics/play (§3.1). Blok yang
   * gagal dikirim `null`, bukan nol (§6.2), dan konektornya tidak ditandai sehat —
   * Health engine lalu menahan evaluasi bila konektor utama mati (FR-8).
   */
  async ingestMetrics(unit: SaasRecord, tanggal: string, now: number, refresh: boolean): Promise<'baru' | 'sudah_ada'> {
    if (!refresh) {
      const ada = await this.repos.db.prepare('SELECT 1 AS ok FROM metric_daily WHERE saas_id = ? AND tanggal = ?').bind(unit.id, tanggal).first();
      if (ada) return 'sudah_ada';
    }

    const ctx = { saasId: unit.id, slug: unit.slug, secret: null, detail: {}, now };
    const [billing, analytics, reviews] = await Promise.all([
      this.connectors.billing.snapshot(ctx).catch(() => null),
      this.connectors.analytics.snapshot(ctx).catch(() => null),
      this.connectors.play.listReviews(ctx, { limit: 20 }).catch(() => null),
    ]);
    const sumber = { billing: Boolean(billing), analytics: Boolean(analytics), play: Boolean(reviews) };
    if (billing) await this.repos.saas.markConnectorHealthy(unit.id, 'billing', now);
    if (analytics) await this.repos.saas.markConnectorHealthy(unit.id, 'analytics', now);
    if (reviews) await this.repos.saas.markConnectorHealthy(unit.id, 'play', now);

    const rating = reviews && reviews.length > 0 ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : null;
    const negatif = reviews ? reviews.filter((r) => r.rating <= 2).length : null;

    // pertumbuhan MRR 7 hari terakhir sebagai proksi komponen pendapatan
    const riwayat = await this.repos.metric.list(unit.id, 30);
    const mrrSekarang = billing?.mrr ?? null;
    const mrrSebelum = riwayat[6]?.metrik.bisnis?.mrr ?? null;
    const pertumbuhan = mrrSekarang !== null && mrrSebelum !== null && mrrSebelum > 0 ? ((mrrSekarang - mrrSebelum) / mrrSebelum) * 100 : null;

    const kandidat = {
      skema_versi: 1 as const,
      tanggal,
      mata_uang: billing?.mataUang === 'IDR' ? ('IDR' as const) : ('USD' as const),
      bisnis: billing
        ? {
            mrr: billing.mrr,
            pelanggan_aktif: billing.pelangganAktif,
            signup_baru: analytics ? Math.max(0, Math.round(analytics.mau * 0.01)) : null,
            churn_bulanan_persen: pertumbuhan !== null && pertumbuhan < -5 ? Math.min(20, Math.abs(pertumbuhan)) : 2.5,
          }
        : null,
      produk: analytics ? { dau: analytics.dau, mau: analytics.mau, aktivasi_persen: analytics.aktivasi } : null,
      toko_aplikasi: reviews
        ? { rating_rata2: rating === null ? null : Math.round(rating * 100) / 100, ulasan_baru: reviews.length, ulasan_negatif: negatif }
        : null,
      stabilitas: analytics ? { error_rate_persen: 0.6, uptime_persen: 99.6, bug_terbuka: 4 } : null,
      biaya: { infra: 25, agen: 1.5 },
    };

    const parsed = DailyMetricSchema.safeParse(kandidat);
    if (!parsed.success) {
      await this.repos.event.emit('metric.rejected', { alasan: parsed.error.issues[0]?.message ?? 'skema tidak valid', tanggal }, { saasId: unit.id, now });
      return 'sudah_ada';
    }

    await this.repos.metric.upsert({ saas_id: unit.id, tanggal, skema_versi: 1, metrik: parsed.data, diterima_pada: now });
    await this.repos.event.emit('metric.ingested', { tanggal, sumber }, { saasId: unit.id, now });
    return 'baru';
  }

  // ------------------------------------------------------------------ health

  /** Evaluasi Health Score + transisi status (FR-8) untuk satu SaaS Unit. */
  async evaluateUnit(unit: SaasRecord, tanggal: string, now: number): Promise<CycleResult['evaluations'][number] | null> {
    if (['dalam_sunset', 'dihentikan', 'diarsipkan'].includes(unit.status)) return null;
    const evaluasi = await this.health.evaluate(unit, tanggal, now);
    // evaluasi disimpan oleh Health engine; perubahan status diterapkan lewat `applyStatus`
    // agar audit `status.berubah` tidak tercatat dua kali.
    if (evaluasi.statusBerubah) await this.health.applyStatus(unit, evaluasi.statusBaru, now);
    return { saasId: unit.id, skor: evaluasi.skor, dari: unit.status, ke: evaluasi.statusBaru, alasan: evaluasi.alasan };
  }

  // ------------------------------------------------------------------ job

  private async queueJob(saasId: string, fungsi: Fungsi, jenis: JobJenis, tanggal: string, now: number): Promise<{ id: string; baru: boolean }> {
    const idemKey = jobIdemKey(saasId, fungsi, jenis, tanggal);
    const dibuat = await this.repos.job.insert({ id: randomId(), saasId, fungsi, jenis, idemKey, batas: DEFAULT_JOB_BATAS, dibuatPada: now });
    const job = await this.repos.job.byIdemKey(idemKey);
    if (!job) return { id: idemKey, baru: false };
    if (!dibuat) return { id: job.id, baru: false };
    await this.repos.event.emit('agent.job.requested', { job_id: job.id, fungsi, jenis, idem_key: idemKey, batas: DEFAULT_JOB_BATAS }, { saasId, now });
    await this.repos.queue.enqueue(TOPIC_JOB, { jobId: job.id }, { now });
    return { id: job.id, baru: true };
  }

  /** Ambil dan jalankan job dari antrean; gagal → retry dengan backoff → dead-letter (§3.3 poin 7). */
  async consumeJobs(opts: { jumlah?: number; now?: number } = {}): Promise<JobRingkas[]> {
    const now = opts.now ?? this.clock();
    const out: JobRingkas[] = [];
    const batas = opts.jumlah ?? 50;
    for (let i = 0; i < batas; i += 1) {
      const message = await this.repos.queue.claim(TOPIC_JOB, { now, maxPercobaan: 3, leaseMs: DEFAULT_JOB_BATAS.timeout_ms * 2 });
      if (!message) break;
      const job = await this.repos.job.byId(String(message.payload.jobId ?? ''));
      if (!job || job.status !== 'queued') {
        await this.repos.queue.ack(message);
        continue;
      }
      const ringkas = (status: string, approvalId: string | null, alasan: string): JobRingkas => ({
        id: job.id,
        saasId: job.saasId,
        fungsi: job.fungsi,
        jenis: job.jenis,
        status,
        approvalId,
        alasan,
      });
      try {
        const hasil = await this.executeJob(job, now);
        await this.repos.queue.ack(message);
        out.push(ringkas(hasil.status, hasil.approvalId, hasil.alasan));
      } catch (error) {
        const pesan = error instanceof Error ? error.message : String(error);
        if (error instanceof SaasPausedError) {
          // job dibatalkan, bukan gagal: kill switch berlaku dalam hitungan detik (NFR-8)
          await this.repos.job.finish(job.id, 'failed', { dibatalkan: pesan }, now);
          await this.repos.queue.ack(message);
          await this.repos.audit.append({ aktor: 'sistem', tindakan: 'job.dibatalkan', saasId: job.saasId, masukan: { job_id: job.id }, keluaran: { alasan: pesan } });
          out.push(ringkas('dibatalkan', null, pesan));
          continue;
        }
        await this.repos.event.emit('agent.job.failed', { job_id: job.id, pesan, percobaan: message.percobaan }, { saasId: job.saasId, now });
        await this.repos.audit.append({ aktor: 'sistem', tindakan: 'job.gagal', saasId: job.saasId, masukan: { job_id: job.id, percobaan: message.percobaan }, keluaran: { pesan } });
        if (message.percobaan >= 3) {
          await this.repos.job.finish(job.id, 'dead', { pesan }, now);
          await this.repos.queue.deadLetter(message.id, JSON.stringify(message.payload), pesan, now);
          out.push(ringkas('dead', null, pesan));
        } else {
          await this.repos.job.setStatus(job.id, 'queued');
          await this.repos.queue.retry(message, backoffMs(message.percobaan), now);
          out.push(ringkas('queued', null, pesan));
        }
      }
    }
    return out;
  }

  async executeJob(job: { id: string; saasId: string; fungsi: Fungsi; jenis: JobJenis }, now: number): Promise<{ status: string; approvalId: string | null; alasan: string }> {
    const saas = await this.repos.saas.byId(job.saasId);
    if (!saas) throw new Error('SaaS Unit tidak ditemukan');
    const kill = await this.repos.kill.state();
    if (saas.paused || kill.global || kill.perSaas.get(saas.id)?.aktif) {
      throw new SaasPausedError('Kill switch aktif: job dibatalkan sebelum agen berjalan');
    }

    await this.repos.job.markRunning(job.id, now);
    const { rt, approvalIds } = await this.loadRuntime(saas, job.id, job.fungsi, now);
    const runId = rt.runId;
    const context = { jobId: job.id, jenis: job.jenis, runId, now };

    let outcome: AgentOutcome<unknown>;
    try {
      outcome = await this.jalankanAgen(job.fungsi, context, rt);
    } catch (error) {
      const pesan = error instanceof Error ? error.message : String(error);
      await this.repos.run.insert({
        id: randomId(),
        jobId: job.id,
        percobaanKe: 1,
        versiPrompt: PROMPT_VERSI[job.fungsi],
        model: this.model.nama,
        mulai: now,
        selesai: this.clock(),
        status: 'gagal',
        ringkasan: pesan,
      });
      throw error;
    }

    const selesai = this.clock();
    await this.repos.run.insert({
      id: randomId(),
      jobId: job.id,
      percobaanKe: 1,
      versiPrompt: PROMPT_VERSI[job.fungsi],
      model: outcome.model,
      mulai: now,
      selesai,
      status: outcome.ditahan ? 'ditahan' : 'selesai',
      tokenMasuk: outcome.tokenMasuk,
      tokenKeluar: outcome.tokenKeluar,
      biayaUsd: outcome.biayaUsd,
      ringkasan: outcome.ringkasanMemori,
    });
    await this.repos.memory.upsert(saas.id, job.fungsi, outcome.ringkasanMemori, selesai);

    const budget = await this.repos.budget.addSpend(saas.id, job.fungsi, periodeBulan(now), outcome.biayaUsd);
    if (budget.batas > 0 && budget.terpakai >= budget.batas) {
      await this.repos.event.emit('budget.exceeded', { fungsi: job.fungsi, batas: budget.batas, terpakai: budget.terpakai }, { saasId: saas.id, runId, now: selesai });
      await this.repos.notifikasi.enqueue({
        kanal: 'log',
        ke: 'pemilik',
        judul: `Anggaran ${job.fungsi} habis: ${saas.nama}`,
        isi: `Anggaran ${job.fungsi} terpakai ${budget.terpakai.toFixed(2)} dari ${budget.batas.toFixed(2)} USD. Agen berhenti sampai periode berikutnya (FR-10.2).`,
        now: selesai,
      });
    }

    const approvalId = approvalIds[0] ?? null;
    const ringkasan = { ringkasan: outcome.ringkasanMemori, biaya_usd: outcome.biayaUsd, langkah: outcome.langkah, ditahan: outcome.ditahan };
    await this.repos.job.finish(job.id, approvalId ? 'awaiting_approval' : 'done', { ...ringkasan, approval_id: approvalId }, selesai);
    await this.repos.event.emit(
      'agent.run.completed',
      { run_id: runId, job_id: job.id, status: outcome.ditahan ? 'ditahan' : 'selesai', biaya_usd: outcome.biayaUsd, approval_id: approvalId },
      { saasId: saas.id, runId, now: selesai },
    );
    await this.repos.audit.append({
      aktor: `agen:${job.fungsi}`,
      tindakan: 'agent.run.selesai',
      saasId: saas.id,
      masukan: { job_id: job.id, jenis: job.jenis },
      keluaran: { ...ringkasan, approval_id: approvalId },
      waktu: selesai,
    });
    return { status: approvalId ? 'awaiting_approval' : 'done', approvalId, alasan: outcome.ringkasanMemori };
  }

  private async jalankanAgen(
    fungsi: Fungsi,
    ctx: { jobId: string; jenis: JobJenis; runId: string; now: number },
    rt: AgentRuntime,
  ): Promise<AgentOutcome<unknown>> {
    switch (fungsi) {
      case 'review':
        return jalankanReview(rt);
      case 'support':
        return jalankanSupport(rt);
      case 'promosi': {
        const hasil = await jalankanPromosi(rt, { mingguan: ctx.jenis === 'promosi_mingguan', minggu: ctx.jenis === 'promosi_mingguan' ? isoWeek(ctx.now) : isoDate(ctx.now) });
        await this.simpanKonten(rt, hasil.hasil);
        return hasil;
      }
      case 'kode': {
        const hasil = await jalankanKode(rt);
        await this.simpanPr(rt, hasil.hasil, ctx.now);
        return hasil;
      }
      case 'parent':
        return jalankanParent(rt, { periode: ctx.jenis === 'parent_mingguan' ? 'mingguan' : 'harian', snapshots: await this.buildSnapshots() });
    }
  }

  /** Runtime agen untuk satu job: konteks, gateway, memori, anggaran. */
  private async loadRuntime(saas: SaasRecord, jobId: string, fungsi: Fungsi, now: number): Promise<{ rt: AgentRuntime; config: SaasConfigResolved; approvalIds: string[] }> {
    const config = resolveConfig(saas);
    const periode = periodeBulan(now);
    const batasUsd = config.anggaran_bulanan_usd[fungsi] ?? config.anggaran_bulanan_usd['token'] ?? 20;
    await this.repos.budget.ensure(saas.id, fungsi, periode, batasUsd);
    const budget = (await this.repos.budget.get(saas.id, fungsi, periode)) ?? { batas: batasUsd, terpakai: 0 };
    const memory = await this.repos.memory.get(saas.id, fungsi);
    const metrics = (await this.repos.metric.list(saas.id, 40)).map((m) => m.metrik).reverse();
    const runId = randomId();
    const approvalIds: string[] = [];

    const gateway = async (req: GatewayCheckRequest): Promise<GatewayDecision> => {
      const hasil = await evaluateGateway(this.gateway, req);
      if (hasil.approval_id) approvalIds.push(hasil.approval_id);
      await this.repos.audit.append({
        aktor: `agen:${fungsi}`,
        tindakan: `gateway.${req.tindakan}`,
        saasId: saas.id,
        masukan: { idem_key: req.idemKey, payload: req.payload },
        keluaran: { keputusan: hasil.keputusan, aturan: hasil.aturan, approval_id: hasil.approval_id },
        waktu: now,
      });
      return {
        keputusan: hasil.keputusan,
        alasan: hasil.alasan,
        approval_id: hasil.approval_id,
        sisa_anggaran_usd: hasil.sisa_anggaran_usd,
        aturan: hasil.aturan,
      };
    };

    const tools: ToolContext = {
      saasId: saas.id,
      fungsi,
      runId,
      jobId,
      gateway,
      efek: async (tindakan, payload) => this.effects(tindakan, { saas, config, runId, now, payload }),
      now,
    };

    const rt: AgentRuntime = {
      runId,
      jobId,
      saas: {
        id: saas.id,
        slug: saas.slug,
        nama: saas.nama,
        status: saas.status,
        config: {
          ...(config.panduan_merek ? { panduan_merek: config.panduan_merek } : {}),
          klaim_terlarang_tambahan: config.klaim_terlarang_tambahan,
          tanda_ai: config.tanda_ai,
          otonomi: config.otonomi,
          review_kategori_otonom: config.review_kategori_otonom,
          batas_pr_baris: config.batas_pr_baris,
          platform: config.platform,
        },
      },
      fungsi,
      now,
      model: this.model,
      connectors: this.connectors,
      connectorSecret: () => null,
      memory,
      budget: { batasUsd: budget.batas, terpakaiUsd: budget.terpakai, peringatan: budget.batas > 0 && budget.terpakai >= budget.batas * 0.8 },
      batasLangkah: DEFAULT_JOB_BATAS.max_langkah,
      sisaAnggaranUsd: budget.batas > 0 ? Math.max(0, budget.batas - budget.terpakai) : null,
      metrics,
      tools,
      logger: (pesan, data) => {
        console.log(JSON.stringify({ level: 'info', msg: pesan, saas_id: saas.id, run_id: runId, job_id: jobId, ...(data ?? {}) }));
      },
    };
    return { rt, config, approvalIds };
  }

  // ------------------------------------------------------------------ efek tulis

  /**
   * Efek setelah gateway mengizinkan. Semua efek deterministik terhadap payload
   * (kunci id yang stabil) sehingga retry job tidak menggandakan konten/review/PR.
   */
  private async effects(
    tindakan: string,
    ctx: { saas: SaasRecord; config: SaasConfigResolved; runId: string; now: number; payload: Record<string, unknown> },
  ): Promise<{ ok: boolean; data?: unknown }> {
    const { saas, payload, runId, now } = ctx;
    const connCtx = { saasId: saas.id, slug: saas.slug, secret: null, detail: {}, now };
    switch (tindakan) {
      case 'simpan_konten':
      case 'terbit_post':
      case 'jadwalkan_post': {
        const id = await this.simpanSatuKonten(saas.id, payload, runId, now);
        if (tindakan !== 'simpan_konten') {
          await this.repos.db.prepare("UPDATE content_item SET status = 'dijadwalkan' WHERE id = ? AND status = 'draf'").bind(id).run();
          await this.repos.event.emit('content.draft.created', { content_id: id, kanal: payload.kanal ?? null, jadwal: payload.jadwal ?? null }, { saasId: saas.id, runId, now });
        }
        return { ok: true, data: { content_id: id } };
      }
      case 'balas_ulasan': {
        const reviewId = String(payload.review_id ?? '');
        if (!reviewId) return { ok: false };
        const res = await this.connectors.play.replyReview(connCtx, reviewId, String(payload.teks ?? ''));
        await this.repos.db
          .prepare("UPDATE review SET balasan = ?, status = 'dibalas' WHERE saas_id = ? AND review_id = ?")
          .bind(String(payload.teks ?? ''), saas.id, reviewId)
          .run();
        return { ok: res.ok, data: res };
      }
      case 'buat_issue': {
        const issue = await this.connectors.github.createIssue(connCtx, {
          judul: String(payload.judul ?? 'Issue dari agen'),
          body: String(payload.body ?? ''),
          labels: Array.isArray(payload.labels) ? payload.labels.map(String) : [],
        });
        return { ok: true, data: issue };
      }
      case 'buka_pr': {
        const perubahan =
          Array.isArray(payload.perubahan) && payload.perubahan.length > 0
            ? (payload.perubahan as Array<{ file: string; isi: string }>)
            : [{ file: 'PERUBAHAN.md', isi: '# Perubahan agen\n' }];
        const pr = await this.connectors.github.createPullRequest(connCtx, {
          judul: String(payload.judul ?? 'Perubahan agen'),
          body: String(payload.body ?? ''),
          branch: String(payload.branch ?? `agent/${runId.slice(0, 8)}`),
          baseBranch: 'main',
          perubahan,
        });
        await this.repos.db
          .prepare(
            `INSERT INTO pull_request_ref (id, saas_id, nomor, repo, judul, url, issue_asal, status, ci_lulus, ringkasan, run_id, dibuat_pada)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'menunggu_review', ?, ?, ?, ?)
             ON CONFLICT (saas_id, repo, nomor) DO NOTHING`,
          )
          .bind(randomId(), saas.id, pr.nomor, saas.repo ?? saas.slug, String(payload.judul ?? ''), pr.url, payload.issue_asal ?? null, pr.ciLulus ? 1 : 0, String(payload.body ?? '').slice(0, 4000), runId, now)
          .run();
        await this.repos.event.emit('pr.opened', { nomor: pr.nomor, url: pr.url, ci_lulus: pr.ciLulus }, { saasId: saas.id, runId, now });
        return { ok: true, data: pr };
      }
      case 'jalankan_render':
        return { ok: true, data: { status: 'dijadwalkan', worker: 'render' } };
      default:
        return { ok: true, data: { tindakan } };
    }
  }

  private async simpanSatuKonten(saasId: string, payload: Record<string, unknown>, runId: string, now: number): Promise<string> {
    const id = `konten:${saasId}:${String(payload.kanal ?? 'instagram')}:${String(payload.judul ?? '')}`;
    await this.repos.db
      .prepare(
        `INSERT INTO content_item (id, saas_id, kanal, status, judul, body, hashtag, alt_text, jadwal, skrip_video, pemeriksaan_klaim, run_id, dibuat_pada)
         VALUES (?, ?, ?, 'draf', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        id,
        saasId,
        String(payload.kanal ?? 'instagram'),
        String(payload.judul ?? ''),
        String(payload.body ?? ''),
        JSON.stringify(payload.hashtag ?? []),
        payload.alt_text ?? null,
        payload.jadwal ?? null,
        payload.skrip_video ? JSON.stringify(payload.skrip_video) : null,
        payload.pemeriksaan_klaim ? JSON.stringify(payload.pemeriksaan_klaim) : null,
        runId,
        now,
      )
      .run();
    return id;
  }

  private async simpanKonten(rt: AgentRuntime, hasil: KeluaranPromosi): Promise<void> {
    for (const item of hasil.kalender) {
      const cek = hasil.pemeriksaan_klaim.find((p) => p.judul === item.judul);
      await this.simpanSatuKonten(
        rt.saas.id,
        { kanal: item.kanal, judul: item.judul, body: item.body, hashtag: item.hashtag, alt_text: item.alt_text, jadwal: item.jadwal, skrip_video: item.skrip_video, pemeriksaan_klaim: cek },
        rt.runId,
        rt.now,
      );
    }
  }

  private async simpanPr(rt: AgentRuntime, hasil: KeluaranKode, now: number): Promise<void> {
    for (const p of hasil.pr) {
      await this.repos.db
        .prepare(
          `INSERT INTO pull_request_ref (id, saas_id, nomor, repo, judul, url, issue_asal, status, ci_lulus, ringkasan, run_id, dibuat_pada)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'draf', NULL, ?, ?, ?)
           ON CONFLICT (saas_id, repo, nomor) DO NOTHING`,
        )
        .bind(
          `pr:${rt.saas.id}:${p.branch}`,
          rt.saas.id,
          Math.abs(hashString(p.branch)) % 10000 + 1,
          rt.saas.slug,
          p.judul,
          p.issue_asal,
          `${p.ringkasan_penyebab}\n\n${p.ringkasan_perubahan}\n\nVerifikasi: ${p.cara_verifikasi}`,
          rt.runId,
          now,
        )
        .run();
    }
  }

  // ------------------------------------------------------------------ snapshot & laporan

  async buildSnapshots(): Promise<SaasSnapshot[]> {
    const units = (await this.repos.saas.all({ limit: 500 })).filter((u) => u.slug !== 'portofolio');
    const metrics = await this.repos.metric.latestForAll(units.map((u) => u.id), 30);
    const out: SaasSnapshot[] = [];
    for (const unit of units) {
      const last = await this.repos.evaluasi.latest(unit.id);
      const metricList = (metrics.get(unit.id) ?? []).map((m) => m.metrik).reverse();
      const health = metricList.length > 0 ? computeHealthFor(metricList, last?.tanggal) : null;
      const terbaru = metricList[metricList.length - 1];
      out.push({
        id: unit.id,
        nama: unit.nama,
        slug: unit.slug,
        status: unit.status,
        health: health && last ? { ...health, skor: last.skor } : health,
        mrr: terbaru?.bisnis?.mrr ?? null,
        signup: terbaru?.bisnis?.signup_baru ?? null,
        rating: terbaru?.toko_aplikasi?.rating_rata2 ?? null,
        biayaAgen: terbaru?.biaya?.agen ?? null,
        kontenTerbit: await this.count("SELECT COUNT(*) AS n FROM content_item WHERE saas_id = ? AND status IN ('terbit','dijadwalkan')", unit.id),
        prTerbuka: await this.count("SELECT COUNT(*) AS n FROM pull_request_ref WHERE saas_id = ? AND status IN ('draf','menunggu_review')", unit.id),
        approvalMenunggu: await this.repos.approval.countPending(unit.id),
      });
    }
    return out;
  }

  private async count(sql: string, ...params: unknown[]): Promise<number> {
    const row = await this.repos.db.prepare(sql).bind(...params).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** Laporan harian portofolio dari Agen Induk (FR-6.3); idempoten per tanggal. */
  async parentReport(tanggal: string, now: number): Promise<string | null> {
    const id = `harian:${tanggal}`;
    if (await this.repos.db.prepare('SELECT 1 AS ok FROM report WHERE id = ?').bind(id).first()) return null;

    const snapshots = await this.buildSnapshots();
    const unit = (await this.repos.saas.all({ limit: 1 }))[0];
    if (!unit || snapshots.length === 0) return null;

    const runtimeUnit: SaasRecord = { ...unit, slug: 'portofolio', nama: 'Portofolio', config: { ...(unit.config as Record<string, unknown>), fungsi_aktif: [] } };
    const jobId = `laporan:${tanggal}`;
    await this.repos.job.insert({ id: jobId, saasId: unit.id, fungsi: 'parent', jenis: 'parent_harian', idemKey: `portofolio:parent:parent_harian:${tanggal}`, batas: DEFAULT_JOB_BATAS, dibuatPada: now });
    const { rt } = await this.loadRuntime(runtimeUnit, jobId, 'parent', now);
    const outcome = await jalankanParent(rt, { periode: 'harian', snapshots });
    await this.repos.report.save({ id, periode: tanggal, isi: { ...outcome.hasil, disusun_pada: new Date(now).toISOString(), biaya_usd: outcome.biayaUsd }, dibuatPada: now });
    await this.repos.job.finish(jobId, 'done', { report_id: id }, now);
    await this.repos.audit.append({ aktor: 'agen:parent', tindakan: 'laporan.harian', masukan: { tanggal }, keluaran: { report_id: id }, waktu: now });
    return id;
  }

  // ------------------------------------------------------------------ persetujuan & sunset

  /** Dependensi policy gateway; dipakai juga oleh rute `/gateway/check` dan orkestrator. */
  gatewayDeps(): GatewayDeps {
    const repos = this.repos;
    return {
      approvals: repos.approval,
      events: repos.event,
      killswitch: repos.kill,
      loadSaas: async (saasId) => {
        const saas = await repos.saas.byId(saasId);
        if (!saas) return null;
        return { status: saas.status, paused: saas.paused, otonomi: resolveConfig(saas).otonomi };
      },
      budget: async (saasId, fungsi) => {
        const saas = await repos.saas.byId(saasId);
        const config = saas ? resolveConfig(saas) : null;
        const batas = config?.anggaran_bulanan_usd[fungsi] ?? config?.anggaran_bulanan_usd['token'] ?? 0;
        return (await repos.budget.get(saasId, fungsi as Fungsi, periodeBulan(this.clock()))) ?? { batas, terpakai: 0 };
      },
      rate: async (saasId, fungsi, limit) => this.guard.cekRate(saasId, fungsi, limit),
      now: () => this.clock(),
      newId: () => randomId(),
      ttlMs: this.deps.ttlMs ?? DEFAULT_APPROVAL_TTL_MS,
    };
  }

  /** Terapkan keputusan persetujuan (FR-7.3, FR-9.3). */
  async decideApproval(
    approvalId: string,
    keputusan: 'disetujui' | 'ditolak' | 'revisi',
    oleh: string,
    catatan?: string,
  ): Promise<{ ok: boolean; status: string; efek?: Record<string, unknown> }> {
    const now = this.clock();
    const approval = await this.repos.approval.byId(approvalId);
    if (!approval) return { ok: false, status: 'tidak_ada' };
    const changed = await this.repos.approval.decide(approvalId, keputusan, oleh, now, catatan ?? null);
    if (!changed) {
      const terkini = await this.repos.approval.byId(approvalId);
      return { ok: false, status: terkini?.status ?? 'tidak_ada' };
    }

    if (approval.jobId) await this.repos.job.setStatus(approval.jobId, keputusan === 'disetujui' ? 'done' : 'failed');

    const efek: Record<string, unknown> = {};
    if (keputusan === 'disetujui') Object.assign(efek, await this.terapkanKeputusan(approval, oleh, now));

    await this.repos.event.emit('approval.resolved', { approval_id: approvalId, keputusan, oleh, catatan: catatan ?? null, efek }, { saasId: approval.saasId, now });
    await this.repos.audit.append({
      aktor: oleh,
      tindakan: `approval.${keputusan}`,
      saasId: approval.saasId,
      masukan: { approval_id: approvalId, jenis: approval.jenis },
      keluaran: { efek, catatan: catatan ?? null },
      waktu: now,
    });
    return { ok: true, status: keputusan, efek };
  }

  private async terapkanKeputusan(
    approval: { saasId: string; jenis: ApprovalJenis; payload: Record<string, unknown> },
    oleh: string,
    now: number,
  ): Promise<Record<string, unknown>> {
    const saas = await this.repos.saas.byId(approval.saasId);
    if (!saas) return {};
    if (approval.jenis === 'rc_plan') {
      await this.health.approveRecoveryPlan(saas, oleh, now);
      return { status: 'percobaan' };
    }
    const tindakan = String(approval.payload['tindakan'] ?? '');
    const payload = (approval.payload['payload'] as Record<string, unknown> | undefined) ?? {};
    const runId = typeof approval.payload['run_id'] === 'string' ? (approval.payload['run_id'] as string) : `approval:${approval.jenis}`;
    const hasil = await this.effects(tindakan, { saas, config: resolveConfig(saas), runId, now, payload });
    return { tindakan, ...(hasil.data && typeof hasil.data === 'object' ? (hasil.data as Record<string, unknown>) : { ok: hasil.ok }) };
  }

  /** Keputusan pemilik atas usulan sunset (FR-8.5): hanya pemilik + MFA. */
  async decideSunset(
    sunsetId: string,
    keputusan: 'disetujui' | 'ditolak' | 'pengecualian',
    oleh: string,
    opts: { catatan?: string; tenggatBaru?: string } = {},
  ): Promise<{ ok: boolean; tahap?: SunsetTahap; status?: SaasStatus }> {
    const now = this.clock();
    const kasus = await this.repos.sunset.byId(sunsetId);
    if (!kasus) return { ok: false };
    if (kasus.keputusan) return { ok: false, tahap: kasus.tahap };
    await this.repos.sunset.decide(sunsetId, keputusan, oleh, now, { catatan: opts.catatan ?? null, tenggatBaru: opts.tenggatBaru ?? null });
    const saas = await this.repos.saas.byId(kasus.saasId);

    if (keputusan === 'disetujui') {
      await this.repos.saas.updateStatus(kasus.saasId, 'dalam_sunset', now);
      await this.repos.sunset.setTahap(sunsetId, 'pengumuman');
      await this.repos.event.emit('sunset.stage.changed', { sunset_id: sunsetId, tahap: 'pengumuman' }, { saasId: kasus.saasId, now });
      await this.repos.audit.append({ aktor: oleh, tindakan: 'sunset.disetujui', saasId: kasus.saasId, masukan: { sunset_id: sunsetId }, keluaran: { tahap: 'pengumuman' }, waktu: now });
      return { ok: true, tahap: 'pengumuman', status: 'dalam_sunset' };
    }

    // ditolak / pengecualian: kembali ke intervensi dengan tenggat baru (tabel FR-8)
    if (!saas) return { ok: true };
    const config = resolveConfig(saas);
    const tenggat = opts.tenggatBaru ?? addDays(isoDate(now), config.kriteria_bangkit.masa_percobaan_hari);
    await this.repos.saas.updateConfig(saas.id, {
      ...(saas.config as Record<string, unknown>),
      kriteria_bangkit: { ...config.kriteria_bangkit, tenggat_iso: tenggat },
      ...(keputusan === 'pengecualian' ? { pengecualian_sunset: true } : {}),
    });
    await this.repos.saas.updateStatus(saas.id, 'intervensi', now);
    await this.repos.sunset.setTahap(sunsetId, 'diusulkan');
    await this.repos.audit.append({ aktor: oleh, tindakan: `sunset.${keputusan}`, saasId: saas.id, masukan: { sunset_id: sunsetId }, keluaran: { tenggat_baru: tenggat }, waktu: now });
    return { ok: true, status: 'intervensi' };
  }

  /** Jalankan tahap sunset berikutnya (FR-8.6); tahap `arsip` menghentikan unit. */
  async advanceSunset(sunsetId: string, oleh: string): Promise<{ ok: boolean; tahap?: SunsetTahap }> {
    const kasus = await this.repos.sunset.byId(sunsetId);
    if (!kasus || kasus.keputusan !== 'disetujui') return { ok: false };
    const urutan: SunsetTahap[] = ['pengumuman', 'tutup_pendaftaran', 'ekspor', 'penagihan', 'takedown', 'arsip'];
    const idx = urutan.indexOf(kasus.tahap);
    if (idx < 0 || idx >= urutan.length - 1) return { ok: false, tahap: kasus.tahap };
    const berikut = urutan[idx + 1]!;
    const now = this.clock();
    await this.repos.sunset.setTahap(sunsetId, berikut);
    if (berikut === 'arsip') await this.repos.saas.updateStatus(kasus.saasId, 'dihentikan', now);
    await this.repos.event.emit('sunset.stage.changed', { sunset_id: sunsetId, tahap: berikut }, { saasId: kasus.saasId, now });
    await this.repos.audit.append({ aktor: oleh, tindakan: 'sunset.tahap', saasId: kasus.saasId, masukan: { sunset_id: sunsetId }, keluaran: { tahap: berikut }, waktu: now });
    return { ok: true, tahap: berikut };
  }
}

function computeHealthFor(metrics: DailyMetric[], tanggal: string | undefined) {
  return computeHealth({ metrics, ...(tanggal ? { tanggal } : {}) });
}

function hashString(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
