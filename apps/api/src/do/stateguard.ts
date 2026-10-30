/**
 * State murni Durable Object `SaasGuard` (§11.5). Tidak mengimpor paket runtime
 * Cloudflare sehingga dapat diuji di Node.
 *
 * Menyediakan kedua bentuk akses: metode `GuardLike` (dipakai `SaasGuard` lewat
 * RPC) dan `handle()` berbasis JSON (dipakai fallback `fetch`).
 * Semantik disamakan dengan `SqlGuard` (`guard.ts`): jendela rate limit tetap
 * per menit, anggaran akumulatif per `(fungsi, periode)`, kill switch menyimpan
 * riwayat kecil di storage.
 */
import {
  hitunganRateLimit,
  type GuardAnggaran,
  type GuardLike,
  type GuardState,
  type GuardStorageLike,
} from './guard.ts';

export interface Estado {
  kill: boolean;
  killAlasan: string | null;
  budget: Record<string, GuardAnggaran>;
  window: { mulai: number; hit: Record<string, number> };
}

function estadoKosong(sekarang: number): Estado {
  return { kill: false, killAlasan: null, budget: {}, window: { mulai: sekarang, hit: {} } };
}

export class SaasGuardState implements GuardLike {
  private readonly storage: GuardStorageLike;
  private cache: Estado | null = null;

  constructor(storage: GuardStorageLike) {
    this.storage = storage;
  }

  private async load(): Promise<Estado> {
    if (this.cache) return this.cache;
    const raw = await this.storage.get<Estado>('state');
    this.cache = { ...estadoKosong(Date.now()), ...(raw ?? {}) };
    return this.cache;
  }

  private async simpan(state: Estado): Promise<void> {
    await this.storage.put('state', state);
  }

  // ------------------------------------------------------- GuardLike

  async status(_saasId: string): Promise<GuardState> {
    const state = await this.load();
    const jumlah = Object.values(state.window.hit).reduce((a, b) => a + b, 0);
    return {
      killSwitch: state.kill,
      killAlasan: state.killAlasan,
      anggaran: { ...state.budget },
      rateLimit: { jendela: state.window.mulai, jumlah },
    };
  }

  async setKillSwitch(_saasId: string, aktif: boolean, alasan: string, aktor: string): Promise<void> {
    const state = await this.load();
    state.kill = aktif;
    state.killAlasan = aktif ? alasan : null;
    await this.simpan(state);
    const riwayat = (await this.storage.get<unknown[]>('riwayat')) ?? [];
    riwayat.push({ aktif, alasan: state.killAlasan, aktor, waktu: Date.now() });
    await this.storage.put('riwayat', riwayat.slice(-20));
  }

  async cekRate(_saasId: string, fungsi: string, limitPerMenit: number): Promise<boolean> {
    const state = await this.load();
    const hit = hitunganRateLimit(Date.now(), state.window, fungsi, limitPerMenit);
    await this.simpan(state);
    return hit.ok;
  }

  async catatBiaya(
    _saasId: string,
    fungsi: string,
    biayaUsd: number,
    periode: string,
    batasUsd = 0,
  ): Promise<{ terpakai: number; batas: number; peringatan: boolean; habis: boolean }> {
    const state = await this.load();
    const key = `${fungsi}:${periode}`;
    const prev = state.budget[key] ?? { batas: 0, terpakai: 0 };
    const batas = batasUsd > 0 ? batasUsd : prev.batas;
    const terpakai = prev.terpakai + biayaUsd;
    state.budget[key] = { batas, terpakai };
    await this.simpan(state);
    return { terpakai, batas, peringatan: batas > 0 && terpakai >= batas * 0.8, habis: batas > 0 && terpakai >= batas };
  }

  // ------------------------------------------------------- JSON (`fetch` DO)

  async handle(body: { op: string; [k: string]: unknown }): Promise<unknown> {
    const saasId = String(body['saas_id'] ?? 'default');
    switch (body['op']) {
      case 'status':
        return this.status(saasId);
      case 'killSwitch':
        await this.setKillSwitch(saasId, Boolean(body['aktif']), String(body['alasan'] ?? ''), String(body['aktor'] ?? 'sistem'));
        return { ok: true, killSwitch: Boolean(body['aktif']) };
      case 'hit':
        return { ok: await this.cekRate(saasId, String(body['fungsi'] ?? 'default'), Number(body['limit'] ?? 60)) };
      case 'addSpend':
        return this.catatBiaya(saasId, String(body['fungsi'] ?? 'default'), Number(body['biaya'] ?? 0), String(body['periode'] ?? ''), Number(body['batas'] ?? 0));
      default:
        return { error: 'op tidak dikenal', op: String(body['op']) };
    }
  }
}
