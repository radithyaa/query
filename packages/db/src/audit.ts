/**
 * Audit log append-only dengan rantai hash (§6.1, NFR-11).
 * Setiap entri menautkan hash SHA-256 dari entri sebelumnya sehingga perubahan
 * diam-diam pada riwayat dapat terdeteksi lewat `verifyChain`.
 */
import { nowMs, sha256Hex, truncate } from '@portfolio/shared';
import type { Database } from './driver.ts';
import { toNum, type Row } from './driver.ts';

export interface AuditEntry {
  waktu: number;
  aktor: string;
  saasId: string | null;
  tindakan: string;
  masukan: unknown;
  keluaran: unknown;
  hashSebelumnya: string | null;
  hash: string;
}

const MSG_LABA: Record<string, string> = {
  audited: 'audit_log bersifat append-only',
};

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return truncate(value, 4000);
  try {
    return truncate(JSON.stringify(value), 4000);
  } catch {
    return null;
  }
}

export class AuditRepo {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  /** Waktu entri terakhir; mencegah `waktu` mundur yang merusak rantai saat audit dibaca berurutan. */
  private async lastWaktuMs(): Promise<number> {
    const row = await this.db.prepare('SELECT MAX(waktu) AS w FROM audit_log').first<Row>();
    return Number(row?.w ?? 0);
  }

  /**
   * Entri terakhir menurut `id` (urutan insert). Id diambil dari `MAX(id)` lalu
   * row dibaca ulang agar `hash` tidak pernah basi walau baris lain baru masuk.
   */
  private async previousHash(): Promise<string | null> {
    const head = await this.db.prepare('SELECT MAX(id) AS id FROM audit_log').first<Row>();
    const maxId = toNum(head?.id);
    if (maxId === null) return null;
    const row = await this.db.prepare('SELECT hash FROM audit_log WHERE id = ?').bind(maxId).first<Row>();
    return row?.hash ? String(row.hash) : null;
  }

  /** Hash kanonik entri: semua field + hash sebelumnya. */
  static async hashEntry(entry: Omit<AuditEntry, 'hash'>): Promise<string> {
    return sha256Hex(
      JSON.stringify({
        waktu: entry.waktu,
        aktor: entry.aktor,
        saas_id: entry.saasId,
        tindakan: entry.tindakan,
        masukan: entry.masukan,
        keluaran: entry.keluaran,
        hash_sebelumnya: entry.hashSebelumnya,
      }),
    );
  }

  async append(input: {
    aktor: string;
    tindakan: string;
    saasId?: string | null;
    masukan?: unknown;
    keluaran?: unknown;
    waktu?: number;
  }): Promise<AuditEntry> {
    // Serialisasi penulisan: rantai hash butuh satu penulis sehingga dua entri tidak
    // menautkan hash yang sama. D1 memproses kueri satu per satu; Node memakai mutex.
    return this.db.chain(async () => {
      // Waktu tidak boleh mundur agar entri selalu lebih baru dari hash sebelumnya.
      const when = Math.max(input.waktu ?? nowMs(), await this.lastWaktuMs());
      const hashSebelumnya = await this.previousHash();
      const entry: Omit<AuditEntry, 'hash'> = {
        waktu: when,
        aktor: input.aktor,
        saasId: input.saasId ?? null,
        tindakan: input.tindakan,
        masukan: serialize(input.masukan),
        keluaran: serialize(input.keluaran),
        hashSebelumnya,
      };
      const hash = await AuditRepo.hashEntry(entry);
      await this.db
        .prepare(
          `INSERT INTO audit_log (waktu, aktor, saas_id, tindakan, masukan, keluaran, hash_sebelumnya, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(entry.waktu, entry.aktor, entry.saasId, entry.tindakan, entry.masukan, entry.keluaran, entry.hashSebelumnya, hash)
        .run();
      return { ...entry, hash };
    });
  }

  /** Batch penulisan audit (dipakai saat beberapa entri harus masuk dalam satu batch). */
  async appendBatch(
    inputs: Array<{ aktor: string; tindakan: string; saasId?: string | null; masukan?: unknown; keluaran?: unknown; waktu?: number }>,
  ): Promise<AuditEntry[]> {
    const out: AuditEntry[] = [];
    for (const input of inputs) out.push(await this.append(input));
    return out;
  }

  async list(query: {
    saasId?: string;
    aktor?: string;
    tindakan?: string;
    dari?: number;
    sampai?: number;
    limit?: number;
    offset?: number;
  }): Promise<Array<AuditEntry & { id: number }>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.saasId) {
      where.push('saas_id = ?');
      params.push(query.saasId);
    }
    if (query.aktor) {
      where.push('aktor = ?');
      params.push(query.aktor);
    }
    if (query.tindakan) {
      where.push('tindakan = ?');
      params.push(query.tindakan);
    }
    if (query.dari !== undefined) {
      where.push('waktu >= ?');
      params.push(query.dari);
    }
    if (query.sampai !== undefined) {
      where.push('waktu <= ?');
      params.push(query.sampai);
    }
    params.push(query.limit ?? 100, query.offset ?? 0);
    const res = await this.db
      .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...params)
      .all<Row>();
    return res.results.map((r) => ({
      id: Number(r.id),
      waktu: Number(r.waktu),
      aktor: String(r.aktor),
      saasId: (r.saas_id as string | null) ?? null,
      tindakan: String(r.tindakan),
      masukan: r.masukan,
      keluaran: r.keluaran,
      hashSebelumnya: (r.hash_sebelumnya as string | null) ?? null,
      hash: String(r.hash ?? ''),
    }));
  }

  /** Verifikasi rantai hash seluruh log; mengembalikan entri pertama yang rusak. */
  async verifyChain(limit = 5000): Promise<{ valid: boolean; checked: number; rusakPada: number | null }> {
    const res = await this.db.prepare('SELECT * FROM audit_log ORDER BY id ASC LIMIT ?').bind(limit).all<Row>();
    let previous: string | null = null;
    let checked = 0;
    for (const row of res.results) {
      const entry: Omit<AuditEntry, 'hash'> = {
        waktu: Number(row.waktu),
        aktor: String(row.aktor),
        saasId: (row.saas_id as string | null) ?? null,
        tindakan: String(row.tindakan),
        masukan: (row.masukan as string | null) ?? null,
        keluaran: (row.keluaran as string | null) ?? null,
        hashSebelumnya: (row.hash_sebelumnya as string | null) ?? null,
      };
      const expected = await AuditRepo.hashEntry(entry);
      if (entry.hashSebelumnya !== previous || expected !== row.hash) {
        return { valid: false, checked, rusakPada: Number(row.id) };
      }
      previous = String(row.hash);
      checked += 1;
    }
    return { valid: true, checked, rusakPada: null };
  }
}

export function auditErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return MSG_LABA[msg] ?? msg;
}
