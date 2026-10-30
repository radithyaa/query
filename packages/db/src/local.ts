/**
 * Driver SQLite lokal (node:sqlite) dengan antarmuka yang sama seperti D1.
 * Dipakai `wrangler dev` pengganti, test, dan runtime Node.
 */
import { DatabaseSync } from 'node:sqlite';
import type { BatchResult, Database, Stmt } from './driver.ts';

class LocalStmt implements Stmt {
  readonly #db: DatabaseSync;
  readonly #sql: string;
  #params: unknown[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]): Stmt {
    this.#params = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  async run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number }; changes?: number }> {
    const result = this.#db.prepare(this.#sql).run(...(this.#params as never[]));
    const changes = Number(result.changes);
    return { success: true, meta: { changes, last_row_id: Number(result.lastInsertRowid) }, changes };
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.#db.prepare(this.#sql).all(...(this.#params as never[]));
    return { results: rows as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.#db.prepare(this.#sql).get(...(this.#params as never[]));
    return (row as T | undefined) ?? null;
  }

  raw(): DatabaseSync {
    return this.#db;
  }
}

export class LocalDatabase implements Database {
  readonly raw: DatabaseSync;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  prepare(sql: string): Stmt {
    return new LocalStmt(this.raw, sql);
  }

  async batch(statements: Stmt[]): Promise<BatchResult> {
    // D1 menjalankan batch sebagai transaksi implisit
    const out: BatchResult = [];
    this.raw.exec('BEGIN');
    try {
      for (const stmt of statements) {
        const res = await stmt.run();
        out.push({ success: res.success, meta: res.meta });
      }
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
    return out;
  }

  async exec(sql: string): Promise<unknown> {
    this.raw.exec(sql);
    return null;
  }

  /** Mutex: antrean promise agar penulisan satu penulis tidak saling menyela. */
  chain<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    this.raw.close();
  }
}
