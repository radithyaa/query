/**
 * Antrean job in-process yang persisten di tabel `job_queue` (§3.3, §3.4).
 *
 * Satu implementasi untuk runtime Node dan Workers: setiap operasi berupa satu
 * statement SQL, jadi beberapa consumer tidak dapat mengambil baris yang sama
 * (lease `terlihat_pada`). Pesan yang melewati batas percobaan dipindah ke
 * dead-letter (`agen_jobs_dlq`) lewat perlakuan yang sama seperti DLQ Queues.
 */
import { safeJsonParse } from '@portfolio/shared';
import type { Database } from '@portfolio/db';

export interface QueueMessage<T = Record<string, unknown>> {
  id: number;
  topic: string;
  payload: T;
  percobaan: number;
}

export const TOPIC_JOB = 'agent_jobs';

/** Topik dead-letter; pesan yang melewati batas percobaan dipindah ke sini. */
export const DLQ_TOPIC = 'agent_jobs_dlq';

export interface EnqueueOptions {
  /** jeda sebelum pesan dapat diambil (backoff) */
  delayMs?: number;
  now?: number;
}

export interface ClaimOptions {
  /** lama lease; pesan yang tidak di-ack kembali tersedia setelahnya */
  leaseMs?: number;
  maxPercobaan?: number;
  now?: number;
}

export class InProcessQueue {
  private readonly db: Database;
  private readonly dlqTopic: string;

  constructor(db: Database, dlqTopic = DLQ_TOPIC) {
    this.db = db;
    this.dlqTopic = dlqTopic;
  }

  async enqueue<T>(topic: string, payload: T, opts: EnqueueOptions = {}): Promise<number> {
    const now = opts.now ?? Date.now();
    const res = await this.db
      .prepare('INSERT INTO job_queue (topic, payload, terlihat_pada, tersedia_pada, percobaan, dibuat_pada) VALUES (?, ?, NULL, ?, 0, ?)')
      .bind(topic, JSON.stringify(payload), now + (opts.delayMs ?? 0), now)
      .run();
    return Number(res.meta?.last_row_id ?? 0);
  }

  /**
   * Ambil satu pesan berikutnya dan tandai lease. Mengembalikan `null` bila kosong.
   * Pesan yang melewati `maxPercobaan` dipindah ke dead-letter.
   */
  async claim(topic: string, opts: ClaimOptions = {}): Promise<QueueMessage | null> {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? 5 * 60_000;
    const maxPercobaan = opts.maxPercobaan ?? 3;

    const row = await this.db
      .prepare(
        `SELECT id, payload, percobaan FROM job_queue
         WHERE topic = ? AND tersedia_pada <= ? AND (terlihat_pada IS NULL OR terlihat_pada < ?)
         ORDER BY tersedia_pada ASC, id ASC LIMIT 1`,
      )
      .bind(topic, now, now - leaseMs)
      .first<{ id: number; payload: string; percobaan: number }>();
    if (!row) return null;

    const id = Number(row.id);
    const percobaan = Number(row.percobaan);
    if (percobaan >= maxPercobaan) {
      await this.deadLetter(row.id, String(row.payload), `melewati ${maxPercobaan} percobaan`, now);
      return this.claim(topic, opts);
    }

    const lease = await this.db
      .prepare('UPDATE job_queue SET terlihat_pada = ?, percobaan = percobaan + 1 WHERE id = ? AND (terlihat_pada IS NULL OR terlihat_pada < ?)')
      .bind(now, id, now - leaseMs)
      .run();
    if (Number(lease.meta?.changes ?? lease.changes ?? 0) === 0) return this.claim(topic, opts);

    return {
      id,
      topic,
      payload: safeJsonParse<Record<string, unknown>>(row.payload) ?? {},
      percobaan: percobaan + 1,
    };
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.db.prepare('DELETE FROM job_queue WHERE id = ?').bind(message.id).run();
  }

  /** Kembalikan pesan ke antrean dengan jeda backoff. */
  async retry(message: QueueMessage, delayMs: number, now = Date.now()): Promise<void> {
    await this.db
      .prepare('UPDATE job_queue SET terlihat_pada = NULL, tersedia_pada = ? WHERE id = ?')
      .bind(now + delayMs, message.id)
      .run();
  }

  async deadLetter(id: number, payload: string, alasan: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare('INSERT INTO job_queue (topic, payload, tersedia_pada, percobaan, dibuat_pada) VALUES (?, ?, ?, 0, ?)')
      .bind(this.dlqTopic, JSON.stringify({ asal: DLQ_TOPIC, queueId: id, alasan, payload: safeJsonParse(payload) ?? payload }), now, now)
      .run();
    await this.db.prepare('DELETE FROM job_queue WHERE id = ?').bind(id).run();
  }

  async size(topic: string, now = Date.now()): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM job_queue WHERE topic = ? AND tersedia_pada <= ?')
      .bind(topic, now)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** Isi dead-letter (dipakai alert `dead-letter tidak kosong`, §5.7). */
  async deadLetterSize(): Promise<number> {
    return this.size(this.dlqTopic, Number.MAX_SAFE_INTEGER);
  }
}

/** Jeda backoff eksponensial dengan batas atas. */
export function backoffMs(percobaan: number, baseMs = 5_000, maxMs = 10 * 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, percobaan - 1));
}
