/**
 * Bootstrap database: migrasi idempoten, helper transaksi, dan kelas repositori
 * yang dibundel menjadi satu objek konteks penyimpanan.
 */
import type { Database } from './driver.ts';
import { MIGRATIONS } from './migrations.ts';
import { AuditRepo } from './audit.ts';
import { MetricRepo, SaasRepo } from './repositories.ts';

export * from './driver.ts';
export * from './local.ts';
export * from './schema.ts';
export * from './migrations.ts';
export * from './repositories.ts';
export * from './audit.ts';

export interface Repos {
  db: Database;
  saas: SaasRepo;
  metric: MetricRepo;
  audit: AuditRepo;
}

export function createRepos(db: Database): Repos {
  return { db, saas: new SaasRepo(db), metric: new MetricRepo(db), audit: new AuditRepo(db) };
}

/**
 * Pecah SQL menjadi pernyataan utuh. Sadar konteks: literal string, kurung
 * (CAST/CHECK), dan blok `BEGIN ... END` milik trigger tidak dipotong.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  let parens = 0;
  let block: 'none' | 'trigger' = 'none';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = '';
    block = 'none';
  };

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;

    if (quote) {
      current += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          current += sql[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl - 1;
      continue;
    }

    if (ch === '(') parens += 1;
    if (ch === ')') parens = Math.max(0, parens - 1);

    if (/^\s*create\s+trigger\b/i.test(current + ch) && block === 'none') block = 'trigger';

    if (ch === ';' && parens === 0) {
      if (block === 'trigger') {
        const head = current.replace(/^\s+/i, '');
        const begins = (head.match(/\bbegin\b/gi) ?? []).length;
        const ends = (head.match(/\bend\b/gi) ?? []).length;
        if (begins > ends) {
          current += ch;
          continue;
        }
      }
      current += ch;
      flush();
      continue;
    }

    current += ch;
  }

  flush();
  return statements;
}

/** Jalankan semua migrasi bila belum diterapkan (idempoten, aman diulang). */
export async function migrate(db: Database): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (tag TEXT PRIMARY KEY, diterapkan INTEGER NOT NULL);');
  const row = await db.prepare('SELECT tag FROM _migrations').all<{ tag: string }>();
  const done = new Set(row.results.map((r) => r.tag));
  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.tag)) continue;
    for (const statement of splitSql(migration.sql)) {
      await db.exec(statement);
    }
    await db.prepare('INSERT INTO _migrations (tag, diterapkan) VALUES (?, ?)').bind(migration.tag, Date.now()).run();
    applied.push(migration.tag);
  }
  return applied;
}
