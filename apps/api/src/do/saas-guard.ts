/**
 * Durable Object `SaasGuard` per SaaS Unit (§11.5): satu penulis sehingga kill
 * switch, sisa anggaran, dan rate limit konsisten walau banyak agen berjalan
 * bersamaan (§3.2, NFR-8).
 *
 * State murni ada di `stateguard.ts`. Kelas ini menyediakan dua bentuk akses:
 *
 *  - `fetch` berbasis JSON (`{op: ...}`) — kontrak yang dipakai
 *    `DurableObjectGuard` di `guard.ts` dan test, sehingga jalur yang diuji sama
 *    dengan produksi;
 *  - RPC generik (`panggil`, `status`, `killSwitch`, `hit`, `addSpend`) untuk
 *    pemanggil yang mendukung RPC Durable Object.
 *
 * Kelas ini tidak mengimpor paket runtime Cloudflare agar tetap dapat
 * di-typecheck/diuji di Node; `wrangler` mengenalinya dari `migrations` di
 * `wrangler*.jsonc`.
 */

import type { GuardStorageLike } from './guard.ts';
import { SaasGuardState } from './stateguard.ts';

export { SaasGuardState };

/** Bagian konteks Durable Object yang dipakai (kompatibel `DurableObjectState`). */
export interface DurableObjectCtxLike {
  storage: GuardStorageLike;
}

export class SaasGuard {
  private readonly state: SaasGuardState;

  constructor(ctx: DurableObjectCtxLike, _env: unknown) {
    this.state = new SaasGuardState(ctx.storage);
  }

  /** Titik masuk RPC generik: `{op, ...}` sesuai `stateguard.handle()`. */
  panggil(body: { op: string; [k: string]: unknown }): Promise<unknown> {
    return this.state.handle(body);
  }

  status(): Promise<unknown> {
    return this.state.status('');
  }

  killSwitch(aktif: boolean, alasan = '', aktor = ''): Promise<void> {
    return this.state.setKillSwitch('', aktif, alasan, aktor);
  }

  hit(fungsi: string, limitPerMenit: number): Promise<boolean> {
    return this.state.cekRate('', fungsi, limitPerMenit);
  }

  addSpend(fungsi: string, periode: string, batasUsd: number, biayaUsd: number) {
    return this.state.catatBiaya('', fungsi, biayaUsd, periode, batasUsd);
  }

  /** Jalur JSON: `POST /<saasId>` dengan body `{op: ...}`. */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const saasId = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'default';
    if (req.method !== 'POST') {
      return Response.json({ error: 'method harus POST', saas_id: saasId }, { status: 405 });
    }
    const body = (await req.json().catch(() => null)) as { op?: unknown } | null;
    if (!body || typeof body.op !== 'string') {
      return Response.json({ error: 'body {op} wajib' }, { status: 400 });
    }
    return Response.json(await this.state.handle({ ...body, op: body.op, saas_id: saasId }));
  }
}
