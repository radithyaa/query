/**
 * Pencarian log audit (FR-7.5) dan verifikasi rantai hash (NFR-11).
 * Rentang tanggal `dari`/`sampai` berupa `YYYY-MM-DD` dan dipetakan ke epoch ms
 * dalam zona UTC agar filter konsisten dengan kolom `waktu`.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/http.ts';
import { apiContext } from '../context.ts';

export interface AuditFilter {
  saas_id?: string;
  aktor?: string;
  tindakan?: string;
  dari?: string;
  sampai?: string;
  limit: number;
  offset: number;
}

function tanggalKeEpoch(value: string, akhirHari = false): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms + (akhirHari ? 86_399_999 : 0) : undefined;
}

/** `masukan`/`keluaran` disimpan sebagai teks JSON; ubah ke objek untuk klien. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export interface AuditItem {
  id: number;
  waktu: number;
  aktor: string;
  saas_id: string | null;
  tindakan: string;
  masukan: unknown;
  keluaran: unknown;
  hash: string;
  hash_sebelumnya: string | null;
}

export async function recentAudit(c: Context<AppEnv>, filter: AuditFilter) {
  const ckv = apiContext(c.env);
  const dari = filter.dari ? tanggalKeEpoch(filter.dari) : undefined;
  const sampai = filter.sampai ? tanggalKeEpoch(filter.sampai, true) : undefined;
  const entries = await ckv.repos.audit.list({
    ...(filter.saas_id ? { saasId: filter.saas_id } : {}),
    ...(filter.aktor ? { aktor: filter.aktor } : {}),
    ...(filter.tindakan ? { tindakan: filter.tindakan } : {}),
    ...(dari !== undefined ? { dari } : {}),
    ...(sampai !== undefined ? { sampai } : {}),
    limit: filter.limit,
    offset: filter.offset,
  });
  // log audit hanya dibaca pemilik; operator melihat SaaS yang ditugaskan saja
  const claims = c.get('claims');
  const terlihat = claims?.role === 'operator' && claims.saas.length > 0 ? entries.filter((e) => !e.saasId || claims.saas.includes(e.saasId)) : entries;
  const data: AuditItem[] = terlihat.map((e) => ({
    id: e.id,
    waktu: e.waktu,
    aktor: e.aktor,
    saas_id: e.saasId,
    tindakan: e.tindakan,
    masukan: parseJson(e.masukan),
    keluaran: parseJson(e.keluaran),
    hash: e.hash,
    hash_sebelumnya: e.hashSebelumnya,
  }));
  return { audit: data, filter: { ...filter, dari_ms: dari ?? null, sampai_ms: sampai ?? null } };
}

export async function verifyAuditChain(c: Context<AppEnv>) {
  const ckv = apiContext(c.env);
  return ckv.repos.audit.verifyChain();
}
