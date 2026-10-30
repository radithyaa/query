/**
 * Kontrak guard bersama untuk policy gateway (§3.3, §11.5).
 *
 * Dua implementasi memakai kontrak yang sama agar orkestrator tidak berubah
 * antara lokal dan produksi:
 *
 *  - `SqlGuard` (runtime Node/test) — kill switch, anggaran, dan rate limit
 *    dibaca/ditulis ke tabel D1/SQLite.
 *  - `DurableObjectGuard` (Workers) — operasi yang sama diteruskan ke satu
 *    Durable Object per SaaS (`SaasGuard`), sehingga satu penulis menjamin
 *    konsistensi walau banyak agen berjalan bersamaan (§3.2, NFR-8).
 *
 * Kontrak `GuardLike` sengaja kecil: hanya masalah yang butuh serialisasi.
 * Keputusan gateway tetap dihitung `decideGateway` yang murni.
 */
import type { Database } from '@portfolio/db';

export interface GuardAnggaran {
  batas: number;
  terpakai: number;
}

export interface GuardState {
  killSwitch: boolean;
  killAlasan: string | null;
  anggaran: Record<string, GuardAnggaran>;
  rateLimit: { jendela: number; jumlah: number };
}

export interface GuardLike {
  status(saasId: string): Promise<GuardState>;
  setKillSwitch(saasId: string, aktif: boolean, alasan: string, aktor: string): Promise<void>;
  /** True bila panggilan ini masih di bawah `limitPerMenit`. */
  cekRate(saasId: string, fungsi: string, limitPerMenit: number): Promise<boolean>;
  catatBiaya(saasId: string, fungsi: string, biayaUsd: number, periode: string): Promise<{ terpakai: number; batas: number; peringatan: boolean; habis: boolean }>;
}

/** Bagian `DurableObjectStorage` yang dipakai `SaasGuardState` (kompatibel dengan storage DO). */
export interface GuardStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const WINDOW_MS = 60_000;

export interface RateLimitResult {
  ok: boolean;
  jumlah: number;
  mulai: number;
}

/**
 * Hitung jendela tetap per menit secara atomik. Dipakai `SqlGuard` dan state DO
 * agar keduanya memakai semantik yang sama (jendela `[awal, awal + 60s)`).
 * Objek `jendela` dimutasi; `mulai` di hasil memuat awal jendela yang berlaku.
 */
export function hitunganRateLimit(
  sekarang: number,
  jendela: { mulai: number; hit: Record<string, number> },
  fungsi: string,
  limitPerMenit: number,
): RateLimitResult {
  if (jendela.mulai === 0 || sekarang - jendela.mulai >= WINDOW_MS) {
    jendela.mulai = sekarang;
    jendela.hit = {};
  }
  const jumlah = (jendela.hit[fungsi] ?? 0) + 1;
  jendela.hit[fungsi] = jumlah;
  return { ok: jumlah <= limitPerMenit, jumlah, mulai: jendela.mulai };
}

/** Guard berbasis tabel untuk runtime Node dan test. */
export class SqlGuard implements GuardLike {
  readonly db: Database;
  readonly global: () => Promise<boolean>;

  constructor(db: Database, globalKill: () => Promise<boolean> = async () => false) {
    this.db = db;
    this.global = globalKill;
  }

  async status(saasId: string): Promise<GuardState> {
    const kill = await this.db
      .prepare('SELECT aktif, alasan FROM kill_switch_event WHERE cakupan = ? AND saas_id = ? ORDER BY id DESC LIMIT 1')
      .bind('saas', saasId)
      .first<{ aktif: number; alasan: string }>();
    const budgets = await this.db
      .prepare('SELECT fungsi, batas_usd, terpakai_usd FROM agent_budget WHERE saas_id = ?')
      .bind(saasId)
      .all<{ fungsi: string; batas_usd: number; terpakai_usd: number }>();
    const anggaran: Record<string, GuardAnggaran> = {};
    for (const b of budgets.results) {
      anggaran[b.fungsi] = { batas: Number(b.batas_usd), terpakai: Number(b.terpakai_usd) };
    }
    return {
      killSwitch: Boolean(kill && Number(kill.aktif) === 1),
      killAlasan: kill && Number(kill.aktif) === 1 ? String(kill.alasan) : null,
      anggaran,
      rateLimit: { jendela: 0, jumlah: 0 },
    };
  }

  async setKillSwitch(saasId: string, aktif: boolean, alasan: string, aktor: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO kill_switch_event (cakupan, saas_id, aktif, alasan, aktor, waktu) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('saas', saasId, aktif ? 1 : 0, alasan, aktor, Date.now())
      .run();
  }

  async cekRate(saasId: string, fungsi: string, limitPerMenit: number): Promise<boolean> {
    const key = `gw:${saasId}:${fungsi}`;
    const now = Date.now();
    const row = await this.db
      .prepare('SELECT createdAt, count FROM rate_limit WHERE key = ?')
      .bind(key)
      .first<{ createdAt: number; count: number }>();
    if (!row || Number(row.createdAt) < now - WINDOW_MS) {
      // satu statement: penggantian jendela dan hit pertama tidak terpisah
      await this.db
        .prepare('INSERT INTO rate_limit (key, createdAt, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET createdAt = excluded.createdAt, count = 1')
        .bind(key, now)
        .run();
      return true;
    }
    if (Number(row.count) >= limitPerMenit) return false;
    await this.db.prepare('UPDATE rate_limit SET count = count + 1 WHERE key = ?').bind(key).run();
    return true;
  }

  async catatBiaya(
    saasId: string,
    fungsi: string,
    biayaUsd: number,
    periode: string,
  ): Promise<{ terpakai: number; batas: number; peringatan: boolean; habis: boolean }> {
    await this.db
      .prepare(
        `INSERT INTO agent_budget (saas_id, fungsi, periode, batas_usd, terpakai_usd) VALUES (?, ?, ?, 0, 0)
         ON CONFLICT (saas_id, fungsi, periode) DO NOTHING`,
      )
      .bind(saasId, fungsi, periode)
      .run();
    await this.db
      .prepare('UPDATE agent_budget SET terpakai_usd = terpakai_usd + ? WHERE saas_id = ? AND fungsi = ? AND periode = ?')
      .bind(biayaUsd, saasId, fungsi, periode)
      .run();
    const row = await this.db
      .prepare('SELECT batas_usd, terpakai_usd FROM agent_budget WHERE saas_id = ? AND fungsi = ? AND periode = ?')
      .bind(saasId, fungsi, periode)
      .first<{ batas_usd: number; terpakai_usd: number }>();
    const batas = Number(row?.batas_usd ?? 0);
    const terpakai = Number(row?.terpakai_usd ?? 0);
    return { terpakai, batas, peringatan: batas > 0 && terpakai >= batas * 0.8, habis: batas > 0 && terpakai >= batas };
  }
}

// ---------------------------------------------------------------- klien Durable Object

export interface GuardNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch: (input: string, init?: RequestInit) => Promise<Response> };
}

async function panggilDo(ns: GuardNamespaceLike, saasId: string, body: Record<string, unknown>): Promise<unknown> {
  const stub = ns.get(ns.idFromName(saasId));
  const res = await stub.fetch(`https://saas-guard/${encodeURIComponent(saasId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SaasGuard gagal (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Adapter `GuardLike` yang meneruskan operasi ke Durable Object `SaasGuard`
 * lewat jalur JSON (`fetch`). Satu jalur ini juga dipakai test dengan stub palsu,
 * jadi perilaku yang diuji sama dengan produksi.
 * Kill switch global tetap dibaca dari tabel karena cakupannya lintas SaaS.
 */
export class DurableObjectGuard implements GuardLike {
  readonly ns: GuardNamespaceLike;
  readonly global: () => Promise<boolean>;

  constructor(ns: GuardNamespaceLike, globalKill: () => Promise<boolean> = async () => false) {
    this.ns = ns;
    this.global = globalKill;
  }

  async status(saasId: string): Promise<GuardState> {
    return (await panggilDo(this.ns, saasId, { op: 'status' })) as GuardState;
  }

  async setKillSwitch(saasId: string, aktif: boolean, alasan: string, aktor: string): Promise<void> {
    await panggilDo(this.ns, saasId, { op: 'killSwitch', aktif, alasan, aktor });
  }

  async cekRate(saasId: string, fungsi: string, limitPerMenit: number): Promise<boolean> {
    const hasil = (await panggilDo(this.ns, saasId, { op: 'hit', fungsi, limit: limitPerMenit })) as { ok: boolean };
    return Boolean(hasil.ok);
  }

  async catatBiaya(
    saasId: string,
    fungsi: string,
    biayaUsd: number,
    periode: string,
    batasUsd = 0,
  ): Promise<{ terpakai: number; batas: number; peringatan: boolean; habis: boolean }> {
    const hasil = (await panggilDo(this.ns, saasId, { op: 'addSpend', fungsi, periode, batas: batasUsd, biaya: biayaUsd })) as {
      batas?: number;
      terpakai?: number;
    };
    const batas = Number(hasil.batas ?? 0);
    const terpakai = Number(hasil.terpakai ?? 0);
    return { terpakai, batas, peringatan: batas > 0 && terpakai >= batas * 0.8, habis: batas > 0 && terpakai >= batas };
  }
}
