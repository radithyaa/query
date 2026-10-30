/**
 * Repositori HTTP untuk tabel sistem. Semua kueri difilter `saas_id` dan
 * penulisan beruntun digabung dengan `db.batch()` (§6.3).
 */
import type { DailyMetric, SaasStatus } from '@portfolio/shared';
import type { Database } from './driver.ts';
import { toBool, toJson, toNum, type Row } from './driver.ts';

export interface SaasRecord {
  id: string;
  slug: string;
  nama: string;
  status: SaasStatus;
  statusSejak: number;
  config: unknown;
  dibuatPada: number;
  repo: string | null;
  akunToko: string | null;
  akunSosial: string | null;
  paused: boolean;
}

export interface ConnectorRecord {
  id: string;
  saasId: string;
  jenis: string;
  secretRef: string;
  terakhirSehat: number | null;
  detail: Record<string, unknown>;
  utama: boolean;
}

export function mapSaas(row: Row): SaasRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    nama: String(row.nama),
    status: String(row.status) as SaasStatus,
    statusSejak: Number(row.status_sejak ?? 0),
    config: toJson(row.config as string, {}),
    dibuatPada: Number(row.dibuat_pada ?? 0),
    repo: (row.repo as string | null) ?? null,
    akunToko: (row.akun_toko as string | null) ?? null,
    akunSosial: (row.akun_sosial as string | null) ?? null,
    paused: toBool(row.paused),
  };
}

export function mapConnector(row: Row): ConnectorRecord {
  return {
    id: String(row.id),
    saasId: String(row.saas_id),
    jenis: String(row.jenis),
    secretRef: String(row.secret_ref),
    terakhirSehat: toNum(row.terakhir_sehat),
    detail: toJson(row.detail as string, {}),
    utama: toBool(row.utama),
  };
}

export interface SaasFilter {
  status?: SaasStatus;
  slug?: string;
  limit?: number;
  offset?: number;
  ids?: string[];
}

export class SaasRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async all(filter: SaasFilter = {}): Promise<SaasRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.slug) {
      where.push('slug = ?');
      params.push(filter.slug);
    }
    if (filter.ids) {
      if (filter.ids.length === 0) return [];
      where.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    const sql = `SELECT * FROM saas_unit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY nama ASC LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 200, filter.offset ?? 0);
    const res = await this.db.prepare(sql).bind(...params).all<Row>();
    return res.results.map(mapSaas);
  }

  async byId(id: string): Promise<SaasRecord | null> {
    const row = await this.db.prepare('SELECT * FROM saas_unit WHERE id = ?').bind(id).first<Row>();
    return row ? mapSaas(row) : null;
  }

  async bySlug(slug: string): Promise<SaasRecord | null> {
    const row = await this.db.prepare('SELECT * FROM saas_unit WHERE slug = ?').bind(slug).first<Row>();
    return row ? mapSaas(row) : null;
  }

  async count(status?: SaasStatus): Promise<number> {
    const row = status
      ? await this.db.prepare('SELECT COUNT(*) AS n FROM saas_unit WHERE status = ?').bind(status).first<Row>()
      : await this.db.prepare('SELECT COUNT(*) AS n FROM saas_unit').first<Row>();
    return Number(row?.n ?? 0);
  }

  async insert(record: {
    id: string;
    slug: string;
    nama: string;
    status: SaasStatus;
    config: unknown;
    dibuatPada: number;
    repo?: string | null;
    akunToko?: string | null;
    akunSosial?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO saas_unit (id, slug, nama, status, status_sejak, config, dibuat_pada, repo, akun_toko, akun_sosial, paused)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .bind(
        record.id,
        record.slug,
        record.nama,
        record.status,
        record.dibuatPada,
        JSON.stringify(record.config),
        record.dibuatPada,
        record.repo ?? null,
        record.akunToko ?? null,
        record.akunSosial ?? null,
      )
      .run();
  }

  async updateStatus(id: string, status: SaasStatus, when: number): Promise<void> {
    await this.db.prepare('UPDATE saas_unit SET status = ?, status_sejak = ? WHERE id = ?').bind(status, when, id).run();
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    await this.db.prepare('UPDATE saas_unit SET paused = ? WHERE id = ?').bind(paused ? 1 : 0, id).run();
  }

  async updateConfig(id: string, config: unknown): Promise<void> {
    await this.db.prepare('UPDATE saas_unit SET config = ? WHERE id = ?').bind(JSON.stringify(config), id).run();
  }

  async connectors(saasId: string): Promise<ConnectorRecord[]> {
    const res = await this.db.prepare('SELECT * FROM connector WHERE saas_id = ?').bind(saasId).all<Row>();
    return res.results.map(mapConnector);
  }

  async upsertConnector(c: {
    id: string;
    saasId: string;
    jenis: string;
    secretRef: string;
    detail: Record<string, unknown>;
    utama: boolean;
    terakhirSehat?: number | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO connector (id, saas_id, jenis, secret_ref, terakhir_sehat, detail, utama)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (saas_id, jenis) DO UPDATE SET secret_ref = excluded.secret_ref, detail = excluded.detail, utama = excluded.utama`,
      )
      .bind(c.id, c.saasId, c.jenis, c.secretRef, c.terakhirSehat ?? null, JSON.stringify(c.detail), c.utama ? 1 : 0)
      .run();
  }

  async markConnectorHealthy(saasId: string, jenis: string, when: number): Promise<void> {
    await this.db.prepare('UPDATE connector SET terakhir_sehat = ? WHERE saas_id = ? AND jenis = ?').bind(when, saasId, jenis).run();
  }
}

export interface MetricRecord {
  saas_id: string;
  tanggal: string;
  skema_versi: number;
  metrik: DailyMetric;
  diterima_pada: number;
}

export class MetricRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  async upsert(record: MetricRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO metric_daily (saas_id, tanggal, skema_versi, metrik, diterima_pada)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (saas_id, tanggal) DO UPDATE SET skema_versi = excluded.skema_versi, metrik = excluded.metrik, diterima_pada = excluded.diterima_pada`,
      )
      .bind(record.saas_id, record.tanggal, record.skema_versi, JSON.stringify(record.metrik), record.diterima_pada)
      .run();
  }

  async list(saasId: string, limit = 90): Promise<MetricRecord[]> {
    const res = await this.db
      .prepare('SELECT * FROM metric_daily WHERE saas_id = ? ORDER BY tanggal DESC LIMIT ?')
      .bind(saasId, limit)
      .all<Row>();
    return res.results.map((row) => ({
      saas_id: String(row.saas_id),
      tanggal: String(row.tanggal),
      skema_versi: Number(row.skema_versi),
      metrik: toJson<DailyMetric>(row.metrik as string, {} as DailyMetric),
      diterima_pada: Number(row.diterima_pada),
    }));
  }

  /** Metrik terakhir per SaaS Unit sekaligus; satu kueri untuk halaman portofolio. */
  async latestForAll(ids: string[], limitPerSaas = 2): Promise<Map<string, MetricRecord[]>> {
    const map = new Map<string, MetricRecord[]>();
    if (ids.length === 0) return map;
    const res = await this.db
      .prepare(
        `SELECT * FROM metric_daily WHERE saas_id IN (${ids.map(() => '?').join(',')}) ORDER BY saas_id ASC, tanggal DESC`,
      )
      .bind(...ids)
      .all<Row>();
    for (const row of res.results) {
      const id = String(row.saas_id);
      const arr = map.get(id) ?? [];
      if (arr.length >= limitPerSaas) continue;
      arr.push({
        saas_id: id,
        tanggal: String(row.tanggal),
        skema_versi: Number(row.skema_versi),
        metrik: toJson<DailyMetric>(row.metrik as string, {} as DailyMetric),
        diterima_pada: Number(row.diterima_pada),
      });
      map.set(id, arr);
    }
    return map;
  }

  async lastIngest(saasId: string): Promise<number | null> {
    const row = await this.db.prepare('SELECT MAX(diterima_pada) AS t FROM metric_daily WHERE saas_id = ?').bind(saasId).first<Row>();
    return toNum(row?.t);
  }
}
