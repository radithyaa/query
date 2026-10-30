/**
 * Guard policy gateway (§3.3, §11.5): kontrak `GuardLike` harus identik antara
 * `SqlGuard` (Node), `DurableObjectGuard` (Workers, lewat DO `SaasGuard`), dan
 * state DO murni. Test ini memakai stub namespace yang meneruskan permintaan ke
 * `SaasGuard.fetch`, jadi jalur yang diuji = jalur produksi.
 */
import { describe, expect, it } from 'vitest';
import { LocalDatabase, migrate, SaasRepo } from '@portfolio/db';
import { DurableObjectGuard, SqlGuard, hitunganRateLimit, type GuardStorageLike } from '../src/do/guard.ts';
import { SaasGuard, SaasGuardState } from '../src/do/saas-guard.ts';
import { buatGuard, buatRepositori, readEnv } from '../src/env.ts';
import { randomId } from '@portfolio/shared';

/** Storage DO palsu di memori (sama kontraknya dengan `DurableObjectStorage`). */
function storageMemori(): GuardStorageLike & { isi: Map<string, unknown> } {
  const isi = new Map<string, unknown>();
  return {
    isi,
    async get<T>(key: string) {
      return isi.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      isi.set(key, structuredClone(value));
    },
  };
}

/** Namespace DO palsu: satu instance `SaasGuard` per nama, dipanggil lewat fetch. */
function namespacePalsu() {
  const instances = new Map<string, SaasGuard>();
  return {
    instances,
    idFromName(name: string) {
      return name;
    },
    get(id: unknown) {
      const name = String(id);
      let guard = instances.get(name);
      if (!guard) {
        guard = new SaasGuard({ storage: storageMemori() }, {});
        instances.set(name, guard);
      }
      return { fetch: (input: string, init?: RequestInit) => guard.fetch(new Request(input, init)) };
    },
  };
}

async function dbUji(): Promise<LocalDatabase> {
  const db = new LocalDatabase(':memory:');
  await migrate(db);
  return db;
}

describe('SqlGuard (Node)', () => {
  it('menghitung rate limit per fungsi dalam jendela menit', async () => {
    const guard = new SqlGuard(await dbUji());
    const saasId = randomId();
    expect(await guard.cekRate(saasId, 'review', 2)).toBe(true);
    expect(await guard.cekRate(saasId, 'review', 2)).toBe(true);
    expect(await guard.cekRate(saasId, 'review', 2)).toBe(false);
    // fungsi lain punya kuota sendiri
    expect(await guard.cekRate(saasId, 'support', 2)).toBe(true);
    // SaaS lain terpisah
    expect(await guard.cekRate(randomId(), 'review', 2)).toBe(true);
  });

  it('menyimpan kill switch per SaaS dan melaporkannya di status', async () => {
    const guard = new SqlGuard(await dbUji());
    const saasId = randomId();
    expect((await guard.status(saasId)).killSwitch).toBe(false);
    await guard.setKillSwitch(saasId, true, 'insiden', 'owner:uji');
    const status = await guard.status(saasId);
    expect(status.killSwitch).toBe(true);
    expect(status.killAlasan).toBe('insiden');
  });

  it('mengakumulasi biaya dan menandai peringatan 80% / habis 100%', async () => {
    const db = await dbUji();
    const guard = new SqlGuard(db);
    const saasId = randomId();
    await new SaasRepo(db).insert({
      id: saasId,
      slug: 'uji-biaya',
      nama: 'Uji Biaya',
      status: 'aktif',
      config: {},
      dibuatPada: Date.now(),
    });
    await db
      .prepare('INSERT INTO agent_budget (saas_id, fungsi, periode, batas_usd, terpakai_usd) VALUES (?, ?, ?, ?, 0)')
      .bind(saasId, 'review', '2026-10', 10)
      .run();
    const setengah = await guard.catatBiaya(saasId, 'review', 4, '2026-10');
    expect(setengah).toMatchObject({ terpakai: 4, batas: 10, peringatan: false, habis: false });
    const delapan = await guard.catatBiaya(saasId, 'review', 4, '2026-10');
    expect(delapan).toMatchObject({ terpakai: 8, peringatan: true, habis: false });
    const penuh = await guard.catatBiaya(saasId, 'review', 2, '2026-10');
    expect(penuh).toMatchObject({ terpakai: 10, peringatan: true, habis: true });
  });
});

describe('SaasGuardState (murni)', () => {
  it('jendela rate limit direset setelah 60 detik', () => {
    const jendela = { mulai: 0, hit: {} };
    expect(hitunganRateLimit(1_000, jendela, 'kode', 1)).toMatchObject({ ok: true, jumlah: 1, mulai: 1_000 });
    expect(hitunganRateLimit(1_500, jendela, 'kode', 1)).toMatchObject({ ok: false, jumlah: 2 });
    // 61 detik kemudian: jendela baru
    expect(hitunganRateLimit(62_000, jendela, 'kode', 1)).toMatchObject({ ok: true, jumlah: 1, mulai: 62_000 });
  });

  it('state bertahan lewat storage (instans baru membaca data lama)', async () => {
    const storage = storageMemori();
    await new SaasGuardState(storage).setKillSwitch('s1', true, 'manual', 'owner:uji');
    const baru = await new SaasGuardState(storage).status('s1');
    expect(baru.killSwitch).toBe(true);
    expect(baru.killAlasan).toBe('manual');
  });
});

describe('DurableObjectGuard (jalur DO)', () => {
  it('membuat satu instance SaasGuard per SaaS', async () => {
    const ns = namespacePalsu();
    const guard = new DurableObjectGuard(ns);
    await guard.setKillSwitch('saas-a', true, 'a', 'owner:uji');
    await guard.setKillSwitch('saas-b', true, 'b', 'owner:uji');
    expect(ns.instances.size).toBe(2);
    expect((await guard.status('saas-a')).killAlasan).toBe('a');
    expect((await guard.status('saas-b')).killAlasan).toBe('b');
  });

  it('menerapkan batas rate limit yang sama dengan SqlGuard', async () => {
    const ns = namespacePalsu();
    const guard = new DurableObjectGuard(ns);
    expect(await guard.cekRate('saas-a', 'kode', 1)).toBe(true);
    expect(await guard.cekRate('saas-a', 'kode', 1)).toBe(false);
  });

  it('melaporkan anggaran lewat addSpend dengan batas dari pemanggil', async () => {
    const guard = new DurableObjectGuard(namespacePalsu());
    const hasil = await guard.catatBiaya('saas-a', 'promosi', 30, '2026-10', 40);
    expect(hasil).toMatchObject({ terpakai: 30, batas: 40, peringatan: false, habis: false });
    const penuh = await guard.catatBiaya('saas-a', 'promosi', 10, '2026-10', 40);
    expect(penuh).toMatchObject({ terpakai: 40, batas: 40, peringatan: true, habis: true });
  });

  it('menolak op tidak dikenal dan method selain POST', async () => {
    const guard = new SaasGuard({ storage: storageMemori() }, {});
    const get = await guard.fetch(new Request('https://guard/saas-a'));
    expect(get.status).toBe(405);
    const takDikenal = await guard.fetch(
      new Request('https://guard/saas-a', { method: 'POST', body: JSON.stringify({ op: 'hapus_semua' }) }),
    );
    expect(await takDikenal.json()).toMatchObject({ error: 'op tidak dikenal' });
  });
});

describe('buatGuard', () => {
  it('memilih SqlGuard tanpa binding SAAS_GUARD dan DO guard dengan binding', async () => {
    const db = await dbUji();
    const lokal = readEnv({ DB: db });
    expect(buatGuard(lokal, async () => false)).toBeInstanceOf(SqlGuard);

    const ns = namespacePalsu();
    const workers = readEnv({ DB: db, SAAS_GUARD: ns });
    expect(buatGuard(workers, async () => false)).toBeInstanceOf(DurableObjectGuard);
  });

  it('memakai repostori kill switch global sebagai sumber kill global', async () => {
    const db = await dbUji();
    const bindings = readEnv({ DB: db });
    bindings.repos = buatRepositori(db);
    const repos = bindings.repos;
    const guard = buatGuard(bindings, async () => (await repos.kill.state()).global);
    expect(await guard.global()).toBe(false);
    await repos.kill.set('global', true, 'uji', 'owner:uji');
    expect(await guard.global()).toBe(true);
  });
});
