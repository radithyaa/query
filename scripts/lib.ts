/**
 * Utilitas bersama skrip CLI: memuat `.env`, membuka database SQLite lokal,
 * menjalankan migrasi, dan membangun binding aplikasi tanpa Cloudflare.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LocalDatabase, migrate } from '@portfolio/db';
import { buatRepositori, readEnv, type Bindings } from '../apps/api/src/env.ts';
import { apiContext } from '../apps/api/src/context.ts';

export const ROOT = resolve(import.meta.dirname, '..');

/** Muat `.env` sederhana (KEY=VALUE, `#` untuk komentar) tanpa menimpa env proses. */
export function loadDotEnv(path = resolve(ROOT, '.env')): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function dbPath(): string {
  return process.env['LOCAL_DB_PATH'] || resolve(ROOT, '.data/portfolio.db');
}

export interface ScriptApp {
  db: LocalDatabase;
  bindings: Bindings;
  ctx: ReturnType<typeof apiContext>;
}

/**
 * Buka database (membuat file bila perlu), jalankan migrasi, dan kembalikan
 * binding aplikasi. `LOCAL_DB_PATH=:memory:` dipakai test.
 */
export async function bukaAplikasi(opts: { path?: string; seedIfEmpty?: boolean } = {}): Promise<ScriptApp> {
  const path = opts.path ?? dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new LocalDatabase(path);
  db.raw.exec('PRAGMA journal_mode = WAL;');
  await migrate(db);
  const bindings = readEnv({
    ...process.env,
    DB: db,
    MOCK_CONNECTORS: process.env['MOCK_CONNECTORS'] ?? 'true',
  });
  bindings.repos = buatRepositori(db);
  const ctx = apiContext(bindings);
  return { db, bindings, ctx };
}

export function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('--')) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
