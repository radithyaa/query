import { describe, expect, it } from 'vitest';
import { LocalDatabase, migrate, createRepos, splitSql, SCHEMA_SQL } from '../src/index.ts';

describe('migrasi skema', () => {
  it('memecah SQL tanpa memotong blok trigger', () => {
    const parts = splitSql(SCHEMA_SQL);
    expect(parts.some((p) => /^CREATE TRIGGER IF NOT EXISTS audit_log_no_update/.test(p))).toBe(true);
    expect(parts.some((p) => p.includes("RAISE(ABORT, 'audit_log bersifat append-only'); END;"))).toBe(true);
    expect(parts.some((p) => /^CREATE TRIGGER IF NOT EXISTS audit_log_no_delete/.test(p))).toBe(true);
    expect(parts.some((p) => p.startsWith('CREATE TABLE IF NOT EXISTS content_item'))).toBe(true);
  });

  it('menerapkan migrasi idempoten', async () => {
    const db = new LocalDatabase();
    expect(await migrate(db)).toEqual(['0001_init']);
    expect(await migrate(db)).toEqual([]);
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = tables.results.map((t) => t.name);
    for (const table of [
      'saas_unit',
      'connector',
      'metric_daily',
      'agent_job',
      'agent_run',
      'agent_memory',
      'agent_budget',
      'approval',
      'health_evaluation',
      'sunset_case',
      'audit_log',
      'content_item',
      'review',
      'pull_request_ref',
      'event_log',
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it('menolak UPDATE dan DELETE pada audit_log', async () => {
    const db = new LocalDatabase();
    await migrate(db);
    const repos = createRepos(db);
    await repos.audit.append({ aktor: 'sistem', tindakan: 'uji.awal' });
    await expect(db.prepare('UPDATE audit_log SET aktor = ?').bind('penyusup').run()).rejects.toThrow(/append-only/);
    await expect(db.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
    db.close();
  });

  it('membuat rantai hash yang terverifikasi', async () => {
    const db = new LocalDatabase();
    await migrate(db);
    const repos = createRepos(db);
    await repos.audit.append({ aktor: 'agen:kode', tindakan: 'pr.dibuka', saasId: 'x', keluaran: { pr: 1 } });
    await repos.audit.append({ aktor: 'user:owner', tindakan: 'approval.disahkan', saasId: 'x' });
    const chain = await repos.audit.verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.checked).toBe(2);
    db.close();
  });

  it('menyimpan dan membaca metrik harian', async () => {
    const db = new LocalDatabase();
    await migrate(db);
    const repos = createRepos(db);
    await repos.saas.insert({ id: 's1', slug: 'contoh', nama: 'Contoh', status: 'aktif', config: {}, dibuatPada: 1 });
    await repos.metric.upsert({
      saas_id: 's1',
      tanggal: '2026-10-29',
      skema_versi: 1,
      metrik: { skema_versi: 1, tanggal: '2026-10-29', mata_uang: 'IDR' } as never,
      diterima_pada: 5,
    });
    const list = await repos.metric.list('s1');
    expect(list).toHaveLength(1);
    expect(list[0]!.tanggal).toBe('2026-10-29');
    db.close();
  });
});
