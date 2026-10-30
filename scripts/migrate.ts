/**
 * Jalankan migrasi SQLite lokal. Di Cloudflare, migrasi yang sama dikirim lewat
 * `wrangler d1 execute --file` dari `SCHEMA_SQL` (`packages/db/src/migrations.ts`).
 */
import { LocalDatabase, migrate, SCHEMA_SQL } from '@portfolio/db';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { arg, dbPath, loadDotEnv, ROOT } from './lib.ts';

loadDotEnv();

const path = arg('db') ?? dbPath();
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const db = new LocalDatabase(path);
const diterapkan = await migrate(db);
console.log(JSON.stringify({ level: 'info', msg: 'migrate.selesai', db: path, diterapkan }));
db.close();

// --sql: tulis ulang berkas SQL untuk `wrangler d1 execute` dari sumber kebenaran.
if (process.argv.includes('--sql')) {
  const dir = resolve(ROOT, 'migrations');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, '0001_init.sql');
  writeFileSync(file, `-- Skema awal D1 untuk \`wrangler d1 execute\` (§3.4).\n-- Dibuat oleh \`npm run migrate -- --sql\`; sumber kebenaran: \`packages/db/src/migrations.ts\`.\n\n${SCHEMA_SQL.trimStart()}`);
  console.log(JSON.stringify({ level: 'info', msg: 'migrate.sql_ditulis', file }));
}
