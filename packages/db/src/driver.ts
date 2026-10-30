/**
 * Antarmuka database yang kompatibel dengan D1 (bind/run/all/first/batch).
 * Implementasi produksi: binding D1 Cloudflare. Implementasi lokal: SQLite (node:sqlite).
 */
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number }; changes?: number }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export type BatchResult = Array<{ success: boolean; results?: unknown[]; meta?: unknown }>;

export interface Database {
  prepare(sql: string): Stmt;
  batch(statements: Stmt[]): Promise<BatchResult>;
  exec(sql: string): Promise<unknown>;
  /**
   * Jalankan `fn` tanpa interleaving dengan pemanggilan `chain` lain. Dipakai
   * penulisan yang butuh satu penulis (rantai hash `audit_log`). D1 sudah
   * memproses kueri satu per satu; implementasi Node memakai mutex.
   */
  chain<T>(fn: () => Promise<T>): Promise<T>;
}

export type Row = Record<string, unknown>;

export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function toJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toBool(value: unknown): boolean {
  return toNum(value) === 1 || value === true;
}
