/**
 * Penyimpanan JSON kecil untuk state orkestrasi yang tidak punya tabel khusus:
 * persetujuan rencana pemulihan yang sedang menunggu (`workflow_state`), dan
 * penanda bahwa plan sudah disetujui (`agent_memory` fungsi `parent`).
 */
import { safeJsonParse } from '@portfolio/shared';
import type { RepositoriSistem } from '../env.ts';

export const WORKFLOW_RC_PLAN = 'rc_plan';

export class JsonStore {
  private readonly repos: RepositoriSistem;
  constructor(repos: RepositoriSistem) {
    this.repos = repos;
  }

  async menyimpanWorkflow(idemKey: string, saasId: string, fungsi: string, jenis: string, konteks: unknown, status = 'baru', now = Date.now()): Promise<void> {
    await this.repos.db
      .prepare(
        `INSERT INTO workflow_state (idem_key, saas_id, fungsi, jenis, langkah, status, konteks, dibuat_pada, diperbarui_pada)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT (idem_key) DO UPDATE SET status = excluded.status, konteks = excluded.konteks, diperbarui_pada = excluded.diperbarui_pada`,
      )
      .bind(idemKey, saasId, fungsi, jenis, status, JSON.stringify(konteks), now, now)
      .run();
  }

  async ambilWorkflow(idemKey: string): Promise<{ status: string; konteks: unknown } | null> {
    const row = await this.repos.db.prepare('SELECT status, konteks FROM workflow_state WHERE idem_key = ?').bind(idemKey).first<{ status: string; konteks: string }>();
    if (!row) return null;
    return { status: row.status, konteks: safeJsonParse(row.konteks) };
  }
}
