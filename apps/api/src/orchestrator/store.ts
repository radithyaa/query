/**
 * Repositori untuk orkestrasi dan persetujuan: `agent_job`, `agent_run`,
 * `agent_memory`, `approval`, `health_evaluation`, `sunset_case`, `event_log`,
 * `kill_switch_event`, `report`, dan `notification_outbox`.
 *
 * Semua kueri difilter `saas_id` (§6.3) dan lewat antarmuka `Database` yang sama
 * dengan D1 sehingga tidak ada ketergantungan pada Cloudflare di lapisan ini.
 */
import {
  isoDate,
  safeJsonParse,
  type ApprovalJenis,
  type ApprovalStatus,
  type Fungsi,
  type JobJenis,
  type JobStatus,
  type SaasStatus,
  type SunsetTahap,
} from '@portfolio/shared';
import { toJson, toNum, type Database, type Row } from '@portfolio/db';

// ---------------------------------------------------------------- job

export interface JobRecord {
  id: string;
  saasId: string;
  fungsi: Fungsi;
  jenis: JobJenis;
  idemKey: string;
  status: JobStatus;
  batas: { max_langkah: number; max_token: number; timeout_ms: number };
  dibuatPada: number;
  mulai: number | null;
  selesai: number | null;
  hasil: unknown;
}

function mapJob(row: Row): JobRecord {
  return {
    id: String(row.id),
    saasId: String(row.saas_id),
    fungsi: String(row.fungsi) as Fungsi,
    jenis: String(row.jenis) as JobJenis,
    idemKey: String(row.idem_key),
    status: String(row.status) as JobStatus,
    batas: toJson(row.batas as string, { max_langkah: 12, max_token: 60_000, timeout_ms: 120_000 }),
    dibuatPada: Number(row.dibuat_pada ?? 0),
    mulai: toNum(row.mulai),
    selesai: toNum(row.selesai),
    hasil: safeJsonParse(row.hasil as string),
  };
}

export class JobRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** True bila job dengan kunci idempoten ini sudah pernah dibuat. */
  async exists(idemKey: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT 1 AS ok FROM agent_job WHERE idem_key = ?').bind(idemKey).first<Row>();
    return Boolean(row);
  }

  async insert(job: {
    id: string;
    saasId: string;
    fungsi: Fungsi;
    jenis: JobJenis;
    idemKey: string;
    batas: unknown;
    dibuatPada: number;
  }): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO agent_job (id, saas_id, fungsi, idem_key, status, batas, dibuat_pada, jenis)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
         ON CONFLICT (idem_key) DO NOTHING`,
      )
      .bind(job.id, job.saasId, job.fungsi, job.idemKey, JSON.stringify(job.batas), job.dibuatPada, job.jenis)
      .run();
    return Number(res.meta?.changes ?? res.changes ?? 0) > 0;
  }

  async byId(id: string): Promise<JobRecord | null> {
    const row = await this.db.prepare('SELECT * FROM agent_job WHERE id = ?').bind(id).first<Row>();
    return row ? mapJob(row) : null;
  }

  async byIdemKey(idemKey: string): Promise<JobRecord | null> {
    const row = await this.db.prepare('SELECT * FROM agent_job WHERE idem_key = ?').bind(idemKey).first<Row>();
    return row ? mapJob(row) : null;
  }

  async listByStatus(status: JobStatus, saasId?: string): Promise<JobRecord[]> {
    const res = saasId
      ? await this.db.prepare('SELECT * FROM agent_job WHERE status = ? AND saas_id = ? ORDER BY dibuat_pada ASC').bind(status, saasId).all<Row>()
      : await this.db.prepare('SELECT * FROM agent_job WHERE status = ? ORDER BY dibuat_pada ASC').bind(status).all<Row>();
    return res.results.map(mapJob);
  }

  async markRunning(id: string, when: number): Promise<void> {
    await this.db.prepare("UPDATE agent_job SET status = 'running', mulai = ? WHERE id = ?").bind(when, id).run();
  }

  async finish(id: string, status: JobStatus, hasil: unknown, when: number): Promise<void> {
    await this.db
      .prepare('UPDATE agent_job SET status = ?, selesai = ?, hasil = ? WHERE id = ?')
      .bind(status, when, hasil === undefined ? null : JSON.stringify(hasil), id)
      .run();
  }

  async setStatus(id: string, status: JobStatus): Promise<void> {
    await this.db.prepare('UPDATE agent_job SET status = ? WHERE id = ?').bind(status, id).run();
  }

  /** Job `running` yang mulai sebelum `before` dianggap macet (`failed` agar bisa dijadwalkan ulang besok). */
  async recoverStuck(before: number): Promise<number> {
    const res = await this.db.prepare("UPDATE agent_job SET status = 'failed', selesai = ? WHERE status = 'running' AND mulai < ?").bind(before, before).run();
    return Number(res.meta?.changes ?? res.changes ?? 0);
  }
}

// ---------------------------------------------------------------- run

export class RunRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async insert(run: {
    id: string;
    jobId: string;
    percobaanKe: number;
    versiPrompt: string;
    model: string;
    mulai: number;
    status: string;
    selesai?: number | null;
    tokenMasuk?: number;
    tokenKeluar?: number;
    biayaUsd?: number;
    ringkasan?: string | null;
    keluaranRef?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_run (id, job_id, percobaan_ke, versi_prompt, model, mulai, selesai, status, token_masuk, token_keluar, biaya_usd, ringkasan, keluaran_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        run.jobId,
        run.percobaanKe,
        run.versiPrompt,
        run.model,
        run.mulai,
        run.selesai ?? null,
        run.status,
        run.tokenMasuk ?? null,
        run.tokenKeluar ?? null,
        run.biayaUsd ?? null,
        run.ringkasan ?? null,
        run.keluaranRef ?? null,
      )
      .run();
  }

  async listForJob(jobId: string): Promise<Row[]> {
    const res = await this.db.prepare('SELECT * FROM agent_run WHERE job_id = ? ORDER BY mulai DESC').bind(jobId).all<Row>();
    return res.results;
  }
}

// ---------------------------------------------------------------- memori & anggaran

export class MemoryRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async get(saasId: string, fungsi: Fungsi): Promise<{ ringkasan: string; diperbaruiPada: number } | null> {
    const row = await this.db
      .prepare('SELECT ringkasan, diperbarui_pada FROM agent_memory WHERE saas_id = ? AND fungsi = ?')
      .bind(saasId, fungsi)
      .first<Row>();
    if (!row) return null;
    return { ringkasan: String(row.ringkasan), diperbaruiPada: Number(row.diperbarui_pada ?? 0) };
  }

  async upsert(saasId: string, fungsi: Fungsi, ringkasan: string, when: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_memory (saas_id, fungsi, ringkasan, diperbarui_pada) VALUES (?, ?, ?, ?)
         ON CONFLICT (saas_id, fungsi) DO UPDATE SET ringkasan = excluded.ringkasan, diperbarui_pada = excluded.diperbarui_pada`,
      )
      .bind(saasId, fungsi, ringkasan, when)
      .run();
  }
}

export class BudgetRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async get(saasId: string, fungsi: Fungsi, periode: string): Promise<{ batas: number; terpakai: number } | null> {
    const row = await this.db
      .prepare('SELECT batas_usd, terpakai_usd FROM agent_budget WHERE saas_id = ? AND fungsi = ? AND periode = ?')
      .bind(saasId, fungsi, periode)
      .first<Row>();
    if (!row) return null;
    return { batas: Number(row.batas_usd ?? 0), terpakai: Number(row.terpakai_usd ?? 0) };
  }

  async ensure(saasId: string, fungsi: Fungsi, periode: string, batasUsd: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_budget (saas_id, fungsi, periode, batas_usd, terpakai_usd) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (saas_id, fungsi, periode) DO UPDATE SET batas_usd = excluded.batas_usd`,
      )
      .bind(saasId, fungsi, periode, batasUsd)
      .run();
  }

  async addSpend(saasId: string, fungsi: Fungsi, periode: string, biayaUsd: number): Promise<{ batas: number; terpakai: number }> {
    await this.db
      .prepare('UPDATE agent_budget SET terpakai_usd = terpakai_usd + ? WHERE saas_id = ? AND fungsi = ? AND periode = ?')
      .bind(biayaUsd, saasId, fungsi, periode)
      .run();
    return (await this.get(saasId, fungsi, periode)) ?? { batas: 0, terpakai: biayaUsd };
  }
}

// ---------------------------------------------------------------- approval

export interface ApprovalRecord {
  id: string;
  saasId: string;
  jobId: string | null;
  jenis: ApprovalJenis;
  fungsi: Fungsi | null;
  ringkasanDampak: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  kedaluwarsa: number;
  dibuatPada: number;
  diputuskanOleh: string | null;
  diputuskanPada: number | null;
  catatan: string | null;
}

export function mapApproval(row: Row): ApprovalRecord {
  return {
    id: String(row.id),
    saasId: String(row.saas_id),
    jobId: (row.job_id as string | null) ?? null,
    jenis: String(row.jenis) as ApprovalJenis,
    fungsi: (row.fungsi as Fungsi | null) ?? null,
    ringkasanDampak: String(row.ringkasan_dampak ?? ''),
    payload: toJson(row.payload as string, {}),
    status: String(row.status) as ApprovalStatus,
    kedaluwarsa: Number(row.kedaluwarsa ?? 0),
    dibuatPada: Number(row.dibuat_pada ?? 0),
    diputuskanOleh: (row.diputuskan_oleh as string | null) ?? null,
    diputuskanPada: toNum(row.diputuskan_pada),
    catatan: (row.catatan as string | null) ?? null,
  };
}

export class ApprovalRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Idempoten per `payload.idemKey`: permintaan berulang mengembalikan baris yang sama. */
  async create(a: {
    id: string;
    saasId: string;
    jobId: string | null;
    jenis: ApprovalJenis;
    fungsi: Fungsi | null;
    ringkasanDampak: string;
    payload: Record<string, unknown>;
    kedaluwarsa: number;
    dibuatPada: number;
  }): Promise<ApprovalRecord> {
    await this.db
      .prepare(
        `INSERT INTO approval (id, saas_id, job_id, jenis, ringkasan_dampak, payload, status, kedaluwarsa, dibuat_pada, fungsi)
         VALUES (?, ?, ?, ?, ?, ?, 'menunggu', ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(a.id, a.saasId, a.jobId, a.jenis, a.ringkasanDampak, JSON.stringify(a.payload), a.kedaluwarsa, a.dibuatPada, a.fungsi)
      .run();
    const row = await this.db.prepare('SELECT * FROM approval WHERE id = ?').bind(a.id).first<Row>();
    return mapApproval(row ?? {});
  }

  async byId(id: string): Promise<ApprovalRecord | null> {
    const row = await this.db.prepare('SELECT * FROM approval WHERE id = ?').bind(id).first<Row>();
    return row ? mapApproval(row) : null;
  }

  /** Cari persetujuan yang masih menunggu untuk kunci idempoten tertentu (anti-duplikat). */
  async pendingForIdemKey(idemKey: string): Promise<ApprovalRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM approval WHERE status = 'menunggu' AND json_extract(payload, '$.idemKey') = ? ORDER BY dibuat_pada DESC LIMIT 1")
      .bind(idemKey)
      .first<Row>();
    return row ? mapApproval(row) : null;
  }

  async list(query: { status?: ApprovalStatus; saasId?: string; fungsi?: Fungsi; limit?: number } = {}): Promise<ApprovalRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.saasId) {
      where.push('saas_id = ?');
      params.push(query.saasId);
    }
    if (query.fungsi) {
      where.push('fungsi = ?');
      params.push(query.fungsi);
    }
    params.push(query.limit ?? 50);
    const res = await this.db
      .prepare(`SELECT * FROM approval ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY dibuat_pada DESC LIMIT ?`)
      .bind(...params)
      .all<Row>();
    return res.results.map(mapApproval);
  }

  /**
   * Putuskan persetujuan secara atomik: hanya baris yang masih `menunggu` dan belum
   * kedaluwarsa yang berubah. False berarti sudah diputuskan / kedaluwarsa (FR-9.3).
   */
  async decide(id: string, keputusan: 'disetujui' | 'ditolak' | 'revisi', oleh: string, when: number, catatan?: string | null): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE approval SET status = ?, diputuskan_oleh = ?, diputuskan_pada = ?, catatan = ?
         WHERE id = ? AND status = 'menunggu' AND kedaluwarsa > ?`,
      )
      .bind(keputusan, oleh, when, catatan ?? null, id, when)
      .run();
    return Number(res.meta?.changes ?? res.changes ?? 0) > 0;
  }

  /** Tandai permintaan yang kedaluwarsa sebagai `kedaluwarsa` (tindakan tidak dijalankan). */
  async expireDue(now: number): Promise<number> {
    const res = await this.db
      .prepare("UPDATE approval SET status = 'kedaluwarsa', diputuskan_pada = ? WHERE status = 'menunggu' AND kedaluwarsa <= ?")
      .bind(now, now)
      .run();
    return Number(res.meta?.changes ?? res.changes ?? 0);
  }

  async countPending(saasId?: string): Promise<number> {
    const row = saasId
      ? await this.db.prepare("SELECT COUNT(*) AS n FROM approval WHERE status = 'menunggu' AND saas_id = ?").bind(saasId).first<Row>()
      : await this.db.prepare("SELECT COUNT(*) AS n FROM approval WHERE status = 'menunggu'").first<Row>();
    return Number(row?.n ?? 0);
  }
}

// ---------------------------------------------------------------- evaluasi, sunset, event

export interface EvaluationRecord {
  id: number;
  saasId: string;
  tanggal: string;
  skor: number;
  komponen: unknown;
  dataCukup: boolean;
  statusLama: SaasStatus;
  statusBaru: SaasStatus;
  alasan: string;
}

function mapEvaluation(row: Row): EvaluationRecord {
  return {
    id: Number(row.id),
    saasId: String(row.saas_id),
    tanggal: String(row.tanggal),
    skor: Number(row.skor),
    komponen: toJson(row.komponen as string, []),
    dataCukup: Number(row.data_cukup) === 1,
    statusLama: String(row.status_lama) as SaasStatus,
    statusBaru: String(row.status_baru) as SaasStatus,
    alasan: String(row.alasan ?? ''),
  };
}

export class EvaluationRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Simpan hasil evaluasi harian; evaluasi dengan tanggal sama ditimpa (`UNIQUE (saas_id, tanggal)`). */
  async save(e: {
    saasId: string;
    tanggal: string;
    skor: number;
    komponen: unknown;
    dataCukup: boolean;
    statusLama: SaasStatus;
    statusBaru: SaasStatus;
    alasan: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO health_evaluation (saas_id, tanggal, skor, komponen, data_cukup, status_lama, status_baru, alasan, tanggal_baru, evaluasi_pulih)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
         ON CONFLICT (saas_id, tanggal) DO UPDATE SET
           skor = excluded.skor, komponen = excluded.komponen, data_cukup = excluded.data_cukup,
           status_lama = excluded.status_lama, status_baru = excluded.status_baru, alasan = excluded.alasan,
           tanggal_baru = excluded.tanggal_baru`,
      )
      .bind(e.saasId, e.tanggal, e.skor, JSON.stringify(e.komponen), e.dataCukup ? 1 : 0, e.statusLama, e.statusBaru, e.alasan, e.tanggal)
      .run();
  }

  /** Riwayat terbaru lebih dulu. */
  async history(saasId: string, limit = 10): Promise<EvaluationRecord[]> {
    const res = await this.db
      .prepare('SELECT * FROM health_evaluation WHERE saas_id = ? ORDER BY tanggal DESC LIMIT ?')
      .bind(saasId, limit)
      .all<Row>();
    return res.results.map(mapEvaluation);
  }

  async latest(saasId: string): Promise<EvaluationRecord | null> {
    return (await this.history(saasId, 1))[0] ?? null;
  }
}

export interface SunsetRecord {
  id: string;
  saasId: string;
  paketBukti: Record<string, unknown>;
  tahap: SunsetTahap;
  keputusan: string | null;
  diputuskanOleh: string | null;
  diputuskanPada: number | null;
  dibuatPada: number;
  tenggatBaru: string | null;
  catatan: string | null;
}

function mapSunset(row: Row): SunsetRecord {
  return {
    id: String(row.id),
    saasId: String(row.saas_id),
    paketBukti: toJson(row.paket_bukti as string, {}),
    tahap: String(row.tahap) as SunsetTahap,
    keputusan: (row.keputusan as string | null) ?? null,
    diputuskanOleh: (row.diputuskan_oleh as string | null) ?? null,
    diputuskanPada: toNum(row.diputuskan_pada),
    dibuatPada: Number(row.dibuat_pada ?? 0),
    tenggatBaru: (row.tenggat_baru as string | null) ?? null,
    catatan: (row.catatan as string | null) ?? null,
  };
}

export class SunsetRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async create(c: { id: string; saasId: string; paketBukti: unknown; tahap: SunsetTahap; dibuatPada: number }): Promise<void> {
    await this.db
      .prepare('INSERT INTO sunset_case (id, saas_id, paket_bukti, tahap, dibuat_pada) VALUES (?, ?, ?, ?, ?)')
      .bind(c.id, c.saasId, JSON.stringify(c.paketBukti), c.tahap, c.dibuatPada)
      .run();
  }

  async byId(id: string): Promise<SunsetRecord | null> {
    const row = await this.db.prepare('SELECT * FROM sunset_case WHERE id = ?').bind(id).first<Row>();
    return row ? mapSunset(row) : null;
  }

  async latestForSaas(saasId: string): Promise<SunsetRecord | null> {
    const row = await this.db.prepare('SELECT * FROM sunset_case WHERE saas_id = ? ORDER BY dibuat_pada DESC LIMIT 1').bind(saasId).first<Row>();
    return row ? mapSunset(row) : null;
  }

  async list(): Promise<SunsetRecord[]> {
    const res = await this.db.prepare('SELECT * FROM sunset_case ORDER BY dibuat_pada DESC').all<Row>();
    return res.results.map(mapSunset);
  }

  async decide(
    id: string,
    keputusan: 'disetujui' | 'ditolak' | 'pengecualian',
    oleh: string,
    when: number,
    opts: { catatan?: string | null; tenggatBaru?: string | null } = {},
  ): Promise<void> {
    await this.db
      .prepare('UPDATE sunset_case SET keputusan = ?, diputuskan_oleh = ?, diputuskan_pada = ?, catatan = ?, tenggat_baru = ? WHERE id = ?')
      .bind(keputusan, oleh, when, opts.catatan ?? null, opts.tenggatBaru ?? null, id)
      .run();
  }

  async setTahap(id: string, tahap: SunsetTahap): Promise<void> {
    await this.db.prepare('UPDATE sunset_case SET tahap = ? WHERE id = ?').bind(tahap, id).run();
  }
}

export class EventRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async emit(nama: string, payload: Record<string, unknown>, opts: { saasId?: string | null; runId?: string | null; now?: number } = {}): Promise<void> {
    await this.db
      .prepare('INSERT INTO event_log (nama, saas_id, run_id, payload, waktu) VALUES (?, ?, ?, ?, ?)')
      .bind(nama, opts.saasId ?? null, opts.runId ?? null, JSON.stringify(payload), opts.now ?? Date.now())
      .run();
  }

  async since(afterId: number, limit = 100): Promise<Array<{ id: number; nama: string; saasId: string | null; runId: string | null; payload: unknown; waktu: number }>> {
    const res = await this.db
      .prepare('SELECT * FROM event_log WHERE id > ? ORDER BY id ASC LIMIT ?')
      .bind(afterId, limit)
      .all<Row>();
    return res.results.map((r) => ({
      id: Number(r.id),
      nama: String(r.nama),
      saasId: (r.saas_id as string | null) ?? null,
      runId: (r.run_id as string | null) ?? null,
      payload: safeJsonParse(r.payload as string),
      waktu: Number(r.waktu),
    }));
  }

  async latestId(): Promise<number> {
    const row = await this.db.prepare('SELECT MAX(id) AS id FROM event_log').first<Row>();
    return Number(row?.id ?? 0);
  }

  async recent(limit = 50): Promise<Array<{ id: number; nama: string; saasId: string | null; waktu: number; payload: unknown }>> {
    const res = await this.db.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT ?').bind(limit).all<Row>();
    return res.results.map((r) => ({
      id: Number(r.id),
      nama: String(r.nama),
      saasId: (r.saas_id as string | null) ?? null,
      waktu: Number(r.waktu),
      payload: safeJsonParse(r.payload as string),
    }));
  }
}

// ---------------------------------------------------------------- kill switch

export interface KillSwitchState {
  global: boolean;
  globalAlasan: string | null;
  perSaas: Map<string, { aktif: boolean; alasan: string }>;
}

export class KillSwitchRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async set(cakupan: 'global' | 'saas', aktif: boolean, alasan: string, aktor: string, opts: { saasId?: string | null; now?: number } = {}): Promise<void> {
    await this.db
      .prepare('INSERT INTO kill_switch_event (cakupan, saas_id, aktif, alasan, aktor, waktu) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(cakupan, opts.saasId ?? null, aktif ? 1 : 0, alasan, aktor, opts.now ?? Date.now())
      .run();
  }

  /** Event terakhir per cakupan menentukan status (NFR-8: berlaku dalam hitungan detik). */
  async state(): Promise<KillSwitchState> {
    const res = await this.db.prepare('SELECT cakupan, saas_id, aktif, alasan FROM kill_switch_event ORDER BY id ASC').all<Row>();
    let global = false;
    let globalAlasan: string | null = null;
    const perSaas = new Map<string, { aktif: boolean; alasan: string }>();
    for (const row of res.results) {
      const aktif = Number(row.aktif) === 1;
      const alasan = String(row.alasan ?? '');
      if (row.cakupan === 'global') {
        global = aktif;
        globalAlasan = aktif ? alasan : null;
      } else if (row.saas_id) {
        perSaas.set(String(row.saas_id), { aktif, alasan });
      }
    }
    return { global, globalAlasan, perSaas };
  }

  async history(limit = 50): Promise<Array<{ id: number; cakupan: string; saasId: string | null; aktif: boolean; alasan: string; aktor: string; waktu: number }>> {
    const res = await this.db.prepare('SELECT * FROM kill_switch_event ORDER BY id DESC LIMIT ?').bind(limit).all<Row>();
    return res.results.map((r) => ({
      id: Number(r.id),
      cakupan: String(r.cakupan),
      saasId: (r.saas_id as string | null) ?? null,
      aktif: Number(r.aktif) === 1,
      alasan: String(r.alasan ?? ''),
      aktor: String(r.aktor),
      waktu: Number(r.waktu),
    }));
  }
}

// ---------------------------------------------------------------- laporan & notifikasi

export interface ReportRecord {
  id: string;
  periode: string;
  saasId: string | null;
  isi: unknown;
  dibuatPada: number;
}

export class ReportRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async save(r: { id: string; periode: string; saasId?: string | null; isi: unknown; dibuatPada?: number }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO report (id, periode, saas_id, isi, dibuat_pada) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET isi = excluded.isi`,
      )
      .bind(r.id, r.periode, r.saasId ?? null, JSON.stringify(r.isi), r.dibuatPada ?? Date.now())
      .run();
  }

  async latest(periode: string): Promise<ReportRecord | null> {
    const row = await this.db.prepare('SELECT * FROM report WHERE periode = ? AND saas_id IS NULL ORDER BY dibuat_pada DESC LIMIT 1').bind(periode).first<Row>();
    if (!row) return null;
    return {
      id: String(row.id),
      periode: String(row.periode),
      saasId: (row.saas_id as string | null) ?? null,
      isi: safeJsonParse(row.isi as string),
      dibuatPada: Number(row.dibuat_pada ?? 0),
    };
  }

  async list(limit = 20): Promise<ReportRecord[]> {
    const res = await this.db.prepare('SELECT * FROM report ORDER BY dibuat_pada DESC LIMIT ?').bind(limit).all<Row>();
    return res.results.map((row) => ({
      id: String(row.id),
      periode: String(row.periode),
      saasId: (row.saas_id as string | null) ?? null,
      isi: safeJsonParse(row.isi as string),
      dibuatPada: Number(row.dibuat_pada ?? 0),
    }));
  }
}

export interface NotificationRecord {
  id: number;
  kanal: string;
  ke: string;
  judul: string;
  isi: string;
  url: string | null;
  status: string;
  dibuatPada: number;
}

export class NotificationRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async enqueue(n: { kanal: string; ke: string; judul: string; isi: string; url?: string | null; status?: string; now?: number }): Promise<number> {
    const res = await this.db
      .prepare('INSERT INTO notification_outbox (kanal, ke, judul, isi, url, status, dibuat_pada) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(n.kanal, n.ke, n.judul, n.isi, n.url ?? null, n.status ?? 'terkirim', n.now ?? Date.now())
      .run();
    return Number(res.meta?.last_row_id ?? 0);
  }

  async list(limit = 50): Promise<NotificationRecord[]> {
    const res = await this.db.prepare('SELECT * FROM notification_outbox ORDER BY id DESC LIMIT ?').bind(limit).all<Row>();
    return res.results.map((r) => ({
      id: Number(r.id),
      kanal: String(r.kanal),
      ke: String(r.ke),
      judul: String(r.judul),
      isi: String(r.isi),
      url: (r.url as string | null) ?? null,
      status: String(r.status),
      dibuatPada: Number(r.dibuat_pada ?? 0),
    }));
  }
}

export { isoDate };
