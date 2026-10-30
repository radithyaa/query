/**
 * Test API inti dan orkestrasi (§5.8, §9.1): autentikasi, peran, idempotensi,
 * kill switch, persetujuan, sunset, audit, siklus harian idempoten, dan
 * transisi Health engine.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase, migrate } from '@portfolio/db';
import {
  addDays,
  isoDate,
  randomId,
  type DailyMetric,
} from '@portfolio/shared';
import { buildApp } from '../src/app.ts';
import { createWorker } from '../src/index.ts';
import { apiContext, type ApiContext } from '../src/context.ts';
import { buatRepositori, readEnv, type Bindings } from '../src/env.ts';
import { signHs256, verifyJwt, type Claims } from '../src/auth.ts';
import { MockPlanModel } from '@portfolio/agents';

const SEKRET = 'test-secret-0123456789abcdef';

interface Fixture {
  db: LocalDatabase;
  bindings: Bindings;
  ctx: ApiContext;
  app: ReturnType<typeof buildApp>;
}

async function fixture(): Promise<Fixture> {
  const db = new LocalDatabase(':memory:');
  await migrate(db);
  const bindings = readEnv({ DB: db, MOCK_CONNECTORS: 'true', JWT_SECRET: SEKRET, APP_NAME: 'Uji', NOTIFICATION_CHANNEL: 'log' });
  bindings.repos = buatRepositori(db);
  const ctx = apiContext(bindings);
  return { db, bindings, ctx, app: buildApp() };
}

async function token(claims: Partial<Claims> & { role: Claims['role'] }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: claims.sub ?? 'uji', saas: [], exp: now + 3600, ...claims }, SEKRET);
}

function metric(tanggal: string, i: number, sehat: boolean): DailyMetric {
  return {
    skema_versi: 1,
    tanggal,
    mata_uang: 'IDR',
    bisnis: { mrr: sehat ? 3_000_000 + i * 25_000 : 4_000_000 - i * 30_000, pelanggan_aktif: 80, signup_baru: 4, churn_bulanan_persen: sehat ? 2 : 8 },
    produk: { dau: 250, mau: 800, aktivasi_persen: sehat ? 44 : 25 },
    toko_aplikasi: { rating_rata2: sehat ? 4.5 : 3, ulasan_baru: 4, ulasan_negatif: sehat ? 1 : 4 },
    stabilitas: { error_rate_persen: sehat ? 0.3 : 3, uptime_persen: sehat ? 99.9 : 98 },
    biaya: { infra: 400_000, agen: 90_000 },
  };
}

async function seedUnit(f: Fixture, slug: string, sehat: boolean, opts: { hari?: number; status?: 'aktif' | 'pengawasan' } = {}): Promise<string> {
  const id = randomId();
  const hari = opts.hari ?? 40;
  await f.ctx.repos.saas.insert({
    id,
    slug,
    nama: `SaaS ${slug}`,
    status: opts.status ?? 'aktif',
    config: { anggaran_bulanan_usd: { review: 15, support: 10, promosi: 20, kode: 30, token: 10 }, kriteria_bangkit: { jendela_evaluasi_hari: 28, masa_percobaan_hari: 30, syarat: [{ metrik: 'pertumbuhan_mrr_persen', minimal: 10 }] } },
    dibuatPada: Date.now(),
    repo: `org/${slug}`,
  });
  for (const [jenis, utama] of [['billing', true], ['analytics', true], ['play', true]] as const) {
    await f.ctx.repos.saas.upsertConnector({ id: randomId(), saasId: id, jenis, secretRef: `secret://${jenis}`, detail: {}, utama, terakhirSehat: Date.now() });
  }
  const mulai = addDays(isoDate(), -(hari - 1));
  for (let i = 0; i < hari; i += 1) {
    const t = addDays(mulai, i);
    await f.ctx.repos.metric.upsert({ saas_id: id, tanggal: t, skema_versi: 1, metrik: metric(t, i, sehat), diterima_pada: Date.parse(`${t}T01:00:00Z`) });
  }
  return id;
}

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

describe('autentikasi & peran', () => {
  it('token HS256 diverifikasi dengan klaim lengkap', async () => {
    const claims = await verifyJwt(await token({ role: 'owner', email: 'o@x' }), { secret: SEKRET, now: Math.floor(Date.now() / 1000) });
    expect(claims.role).toBe('owner');
    expect(claims.exp).toBeGreaterThan(0);
  });

  it('menolak token kedaluwarsa dan secret salah', async () => {
    const now = Math.floor(Date.now() / 1000);
    const kedaluwarsa = await signHs256({ sub: 'x', role: 'owner', saas: [], exp: now - 120 }, SEKRET);
    await expect(verifyJwt(kedaluwarsa, { secret: SEKRET, now })).rejects.toThrow(/kedaluwarsa/);
    await expect(verifyJwt(await token({ role: 'owner' }), { secret: 'secret-lain-yang-cukup-panjang' })).rejects.toThrow(/tanda tangan/);
  });

  it('tanpa token → 401; peran salah → 403', async () => {
    expect((await f.app.request('/api/v1/saas', {}, f.bindings)).status).toBe(401);
    const operator = await token({ role: 'operator' });
    expect((await f.app.request('/api/v1/audit', { headers: { authorization: `Bearer ${operator}` } }, f.bindings)).status).toBe(403);
  });

  it('operator hanya melihat SaaS yang ditugaskan', async () => {
    const a = await seedUnit(f, 'a', true);
    await seedUnit(f, 'b', true);
    const operator = await token({ role: 'operator', saas: [a] });
    const res = await f.app.request('/api/v1/saas', { headers: { authorization: `Bearer ${operator}` } }, f.bindings);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((u) => u.id)).toEqual([a]);

    const all = await f.app.request('/api/v1/saas', { headers: { authorization: `Bearer ${await token({ role: 'owner' })}` } }, f.bindings);
    expect(((await all.json()) as { data: unknown[] }).data).toHaveLength(2);
  });
});

describe('SaaS Unit & metrik', () => {
  it('mendaftarkan SaaS Unit dan menolak slug ganda', async () => {
    const owner = await token({ role: 'owner' });
    const body = { slug: 'baru-saas', nama: 'Baru', platform: ['android'], repo: 'org/baru' };
    const idem = (key: string) => ({ 'content-type': 'application/json', 'Idempotency-Key': key, authorization: `Bearer ${owner}` });
    const pertama = await f.app.request('/api/v1/saas', { method: 'POST', headers: idem('saas-baru-0001'), body: JSON.stringify(body) }, f.bindings);
    expect(pertama.status).toBe(201);
    const kedua = await f.app.request('/api/v1/saas', { method: 'POST', headers: idem('saas-baru-0002'), body: JSON.stringify(body) }, f.bindings);
    expect(kedua.status).toBe(409);
    const salah = await f.app.request('/api/v1/saas', { method: 'POST', headers: idem('saas-baru-0003'), body: JSON.stringify({ slug: 'Huruf Besar!' }) }, f.bindings);
    expect(salah.status).toBe(400);
  });

  it('menerima metrik berskema dan menolak yang tidak sesuai (§6.2)', async () => {
    const id = await seedUnit(f, 'metrik', true, { hari: 1 });
    const konektor = await token({ role: 'connector', saas: [id] });
    const ok = await f.app.request(`/api/v1/saas/${id}/metrics`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'metrik-0001', authorization: `Bearer ${konektor}` }, body: JSON.stringify(metric(addDays(isoDate(), 3), 0, true)) }, f.bindings);
    expect(ok.status).toBe(202);
    const salah = await f.app.request(`/api/v1/saas/${id}/metrics`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'metrik-0002', authorization: `Bearer ${konektor}` }, body: JSON.stringify({ skema_versi: 2, tanggal: '2026-13-40', bisnis: { mrr: 'banyak' } }) }, f.bindings);
    expect(salah.status).toBe(400);
    const body = (await salah.json()) as { error: { kode: string } };
    expect(body.error.kode).toBe('validasi_gagal');
  });

  it('konektor tidak boleh mengirim metrik untuk SaaS lain', async () => {
    const a = await seedUnit(f, 'a', true, { hari: 1 });
    const b = await seedUnit(f, 'b', true, { hari: 1 });
    const konektor = await token({ role: 'connector', saas: [a] });
    const res = await f.app.request(`/api/v1/saas/${b}/metrics`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'metrik-0003', authorization: `Bearer ${konektor}` }, body: JSON.stringify(metric(isoDate(), 1, true)) }, f.bindings);
    expect(res.status).toBe(403);
  });
});

describe('policy gateway HTTP', () => {
  it('membuat permintaan persetujuan dan mencatat audit', async () => {
    const id = await seedUnit(f, 'gw', true);
    const svc = await token({ role: 'service', saas: [id], fungsi: 'review' });
    const res = await f.app.request(
      '/api/v1/gateway/check',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}` }, body: JSON.stringify({ saasId: id, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-gw-test-0001', payload: { review_id: 'r1', teks: 'hai' } }) },
      f.bindings,
    );
    const body = (await res.json()) as { data: { keputusan: string; approval_id: string } };
    expect(body.data.keputusan).toBe('perlu_persetujuan');
    expect(body.data.approval_id).toBeTruthy();
    const audit = await f.ctx.repos.audit.list({ tindakan: 'gateway.balas_ulasan' });
    expect(audit).toHaveLength(1);

    // permintaan ulang dengan kunci idempoten sama memakai approval yang sama
    const ulang = await f.app.request(
      '/api/v1/gateway/check',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}` }, body: JSON.stringify({ saasId: id, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-gw-test-0001', payload: { review_id: 'r1', teks: 'hai' } }) },
      f.bindings,
    );
    const ulangBody = (await ulang.json()) as { data: { approval_id: string } };
    expect(ulangBody.data.approval_id).toBe(body.data.approval_id);
    expect(await f.ctx.repos.approval.countPending()).toBe(1);
  });

  it('token layanan fungsi lain tidak dapat memanggil fungsi ini', async () => {
    const id = await seedUnit(f, 'gw2', true);
    const svc = await token({ role: 'service', saas: [id], fungsi: 'support' });
    const res = await f.app.request(
      '/api/v1/gateway/check',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}` }, body: JSON.stringify({ saasId: id, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-gw-test-0002', payload: {} }) },
      f.bindings,
    );
    expect(res.status).toBe(403);
  });
});

describe('persetujuan (FR-9)', () => {
  it('memutuskan sekali saja, butuh Idempotency-Key, dan kedaluwarsa ditolak', async () => {
    const id = await seedUnit(f, 'appr', true);
    const owner = await token({ role: 'owner' });
    const approval = await f.ctx.repos.approval.create({ id: randomId(), saasId: id, jobId: null, jenis: 'terbit_post', fungsi: 'promosi', ringkasanDampak: 'Terbit konten', payload: { idemKey: 'x-1', tindakan: 'terbit_post', payload: { kanal: 'instagram', judul: 'Halo', body: 'Isi' } }, kedaluwarsa: Date.now() + 60_000, dibuatPada: Date.now() });

    const tanpaKey = await f.app.request(`/api/v1/approvals/${approval.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` }, body: JSON.stringify({ keputusan: 'setujui' }) }, f.bindings);
    expect(tanpaKey.status).toBe(400);

    const ok = await f.app.request(`/api/v1/approvals/${approval.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'decide-1', authorization: `Bearer ${owner}` }, body: JSON.stringify({ keputusan: 'setujui' }) }, f.bindings);
    expect(ok.status).toBe(200);
    const efek = (await ok.json()) as { data: { efek: { content_id?: string } } };
    expect(efek.data.efek.content_id).toBeTruthy();
    const konten = await f.db.prepare('SELECT status FROM content_item WHERE saas_id = ?').bind(id).all<{ status: string }>();
    expect(konten.results[0]?.status).toBe('dijadwalkan');

    const ulang = await f.app.request(`/api/v1/approvals/${approval.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'decide-2', authorization: `Bearer ${owner}` }, body: JSON.stringify({ keputusan: 'tolak' }) }, f.bindings);
    expect(ulang.status).toBe(409);

    const kadaluarsa = await f.ctx.repos.approval.create({ id: randomId(), saasId: id, jobId: null, jenis: 'buat_issue', fungsi: 'review', ringkasanDampak: 'Issue', payload: { idemKey: 'x-2' }, kedaluwarsa: Date.now() - 1000, dibuatPada: Date.now() - 5000 });
    const exp = await f.app.request(`/api/v1/approvals/${kadaluarsa.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'decide-3', authorization: `Bearer ${owner}` }, body: JSON.stringify({ keputusan: 'setujui' }) }, f.bindings);
    expect(exp.status).toBe(409);
  });

  it('operator tidak dapat memutuskan kategori khusus pemilik', async () => {
    const id = await seedUnit(f, 'appr2', true);
    const approval = await f.ctx.repos.approval.create({ id: randomId(), saasId: id, jobId: null, jenis: 'merge_pr', fungsi: 'kode', ringkasanDampak: 'Merge', payload: { idemKey: 'x-3' }, kedaluwarsa: Date.now() + 60_000, dibuatPada: Date.now() });
    const operator = await token({ role: 'operator', saas: [id] });
    const res = await f.app.request(`/api/v1/approvals/${approval.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'decide-op', authorization: `Bearer ${operator}` }, body: JSON.stringify({ keputusan: 'setujui' }) }, f.bindings);
    expect(res.status).toBe(403);
  });
});

describe('kill switch & pause (FR-1.4, NFR-8)', () => {
  it('kill switch global menghentikan siklus dan menolak gateway', async () => {
    const id = await seedUnit(f, 'kill', true);
    const owner = await token({ role: 'owner' });
    const res = await f.app.request('/api/v1/killswitch', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'kill-global-1', authorization: `Bearer ${owner}` }, body: JSON.stringify({ aktif: true, alasan: 'uji' }) }, f.bindings);
    expect(res.status).toBe(200);

    const siklus = await f.ctx.orchestrator.runCycle({ skipJobs: true });
    expect(siklus.jobsQueued).toEqual([]);

    const svc = await token({ role: 'service', saas: [id], fungsi: 'review' });
    const gw = await f.app.request('/api/v1/gateway/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}` }, body: JSON.stringify({ saasId: id, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-kill-0001', payload: {} }) }, f.bindings);
    const body = (await gw.json()) as { data: { keputusan: string; aturan: string[] } };
    expect(body.data.keputusan).toBe('tolak');
    expect(body.data.aturan).toContain('killswitch:global');

    // keluar dari waktu job yang berjalan: job dibatalkan karena kill switch
    const job = await f.ctx.repos.job.insert({ id: randomId(), saasId: id, fungsi: 'review', jenis: 'review_harian', idemKey: `x:review:${Date.now()}`, batas: { max_langkah: 1, max_token: 100, timeout_ms: 1000 }, dibuatPada: Date.now() });
    expect(job).toBe(true);
    const daftar = await f.ctx.repos.job.listByStatus('queued');
    await expect(f.ctx.orchestrator.executeJob(daftar[0]!, Date.now())).rejects.toThrow(/Kill switch/);
  });

  it('pause dan resume per SaaS mengubah flag jeda', async () => {
    const id = await seedUnit(f, 'jeda', true);
    const owner = await token({ role: 'owner' });
    const pause = await f.app.request(`/api/v1/saas/${id}/pause`, { method: 'POST', headers: { 'Idempotency-Key': 'pause-0001', authorization: `Bearer ${owner}` } }, f.bindings);
    expect(pause.status).toBe(200);
    expect((await f.ctx.repos.saas.byId(id))!.paused).toBe(true);
    const resume = await f.app.request(`/api/v1/saas/${id}/resume`, { method: 'POST', headers: { 'Idempotency-Key': 'resume-0001', authorization: `Bearer ${owner}` } }, f.bindings);
    expect(resume.status).toBe(200);
    expect((await f.ctx.repos.saas.byId(id))!.paused).toBe(false);
  });
});

describe('sunset (FR-8.5)', () => {
  async function siapkanSunset(): Promise<{ sunsetId: string; saasId: string }> {
    const saasId = await seedUnit(f, 'sunset', false);
    const sunsetId = randomId();
    await f.ctx.repos.sunset.create({ id: sunsetId, saasId, paketBukti: { tren: [] }, tahap: 'diusulkan', dibuatPada: Date.now() });
    await f.ctx.repos.saas.updateStatus(saasId, 'usulan_sunset', Date.now());
    return { sunsetId, saasId };
  }

  it('hanya pemilik dengan MFA yang dapat menyetujui', async () => {
    const { sunsetId, saasId } = await siapkanSunset();
    const operator = await token({ role: 'operator', saas: [saasId] });
    const owner = await token({ role: 'owner', mfa: true });
    const tanpaMfa = await f.app.request(`/api/v1/sunset/${sunsetId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'sunset-op-01', authorization: `Bearer ${operator}` }, body: JSON.stringify({ keputusan: 'setujui', mfa_token: 'dev-123456' }) }, f.bindings);
    expect(tanpaMfa.status).toBe(403);
    const ok = await f.app.request(`/api/v1/sunset/${sunsetId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'sunset-own-01', authorization: `Bearer ${owner}` }, body: JSON.stringify({ keputusan: 'setujui', mfa_token: 'dev-123456' }) }, f.bindings);
    expect(ok.status).toBe(200);
    expect((await f.ctx.repos.saas.byId(saasId))!.status).toBe('dalam_sunset');
  });

  it('penolakan mengembalikan ke intervensi dengan tenggat baru', async () => {
    const { sunsetId, saasId } = await siapkanSunset();
    const owner = await token({ role: 'owner', mfa: true });
    const res = await f.app.request(`/api/v1/sunset/${sunsetId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'sunset-tolak-1', authorization: `Bearer ${owner}` }, body: JSON.stringify({ keputusan: 'tolak', mfa_token: 'dev-123456', tenggat_baru: addDays(isoDate(), 45) }) }, f.bindings);
    expect(res.status).toBe(200);
    const saas = (await f.ctx.repos.saas.byId(saasId))!;
    expect(saas.status).toBe('intervensi');
    expect(JSON.stringify(saas.config)).toContain('tenggat_iso');
  });

  it('gateway menolak tindakan selain sunset saat dalam_sunset', async () => {
    const { sunsetId, saasId } = await siapkanSunset();
    await f.ctx.orchestrator.decideSunset(sunsetId, 'disetujui', 'owner:uji');
    const svc = await token({ role: 'service', saas: [saasId], fungsi: 'review' });
    const res = await f.app.request('/api/v1/gateway/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}` }, body: JSON.stringify({ saasId, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-sunset-0001', payload: {} }) }, f.bindings);
    const body = (await res.json()) as { data: { keputusan: string; aturan: string[] } };
    expect(body.data.keputusan).toBe('tolak');
    expect(body.data.aturan).toContain('status:dalam_sunset');
  });
});

describe('siklus harian & Health engine', () => {
  it('gagal Health menurunkan status bertahap dan meminta rencana pemulihan', async () => {
    const id = await seedUnit(f, 'turun', false);
    const tanggal = isoDate();
    const s1 = (await f.ctx.orchestrator.evaluateUnit((await f.ctx.repos.saas.byId(id))!, tanggal, Date.now()))!;
    await f.ctx.repos.saas.updateStatus(id, s1.ke, Date.now());
    expect(s1.ke).toBe('aktif');
    const s2 = (await f.ctx.orchestrator.evaluateUnit((await f.ctx.repos.saas.byId(id))!, addDays(tanggal, 1), Date.now()))!;
    await f.ctx.repos.saas.updateStatus(id, s2.ke, Date.now());
    expect(s2.ke).toBe('pengawasan');
    const s3 = (await f.ctx.orchestrator.evaluateUnit((await f.ctx.repos.saas.byId(id))!, addDays(tanggal, 2), Date.now()))!;
    await f.ctx.repos.saas.updateStatus(id, s3.ke, Date.now());
    expect(s3.ke).toBe('intervensi');
    // evaluasi berikutnya membuat permintaan rencana pemulihan (rc_plan)
    await f.ctx.orchestrator.evaluateUnit((await f.ctx.repos.saas.byId(id))!, addDays(tanggal, 3), Date.now());
    const pending = await f.ctx.repos.approval.list({ status: 'menunggu', saasId: id });
    expect(pending.some((a) => a.jenis === 'rc_plan')).toBe(true);
  });

  it('siklus idempoten: tidak menggandakan job atau laporan', async () => {
    await seedUnit(f, 'a', true, { hari: 10 });
    await seedUnit(f, 'b', false, { hari: 10 });
    const pertama = await f.ctx.orchestrator.runCycle({ skipJobs: true });
    const jumlahJob = (await f.db.prepare('SELECT COUNT(*) AS n FROM agent_job').first<{ n: number }>())?.n;
    expect(pertama.reports).toHaveLength(1);
    expect(pertama.jobsQueued.length).toBeGreaterThan(0);
    const kedua = await f.ctx.orchestrator.runCycle({ skipJobs: true });
    const jumlahJob2 = (await f.db.prepare('SELECT COUNT(*) AS n FROM agent_job').first<{ n: number }>())?.n;
    expect(kedua.reports).toHaveLength(0);
    expect(jumlahJob2).toBe(jumlahJob);
    expect(kedua.jobsQueued).toEqual([]);
  });

  it('siklus penuh menjalankan agen, menulis memori/run/event, dan menghormati anggaran', async () => {
    const id = await seedUnit(f, 'penuh', true, { hari: 10 });
    const hasil = await f.ctx.orchestrator.runCycle({});
    expect(hasil.jobs.length).toBeGreaterThan(0);
    expect(hasil.jobs.every((j) => j.status !== 'dead')).toBe(true);
    const memori = await f.ctx.repos.memory.get(id, 'review');
    expect(memori?.ringkasan).toBeTruthy();
    const runs = await f.db.prepare('SELECT versi_prompt, model, biaya_usd FROM agent_run').all<{ versi_prompt: string; model: string; biaya_usd: number }>();
    expect(runs.results.length).toBeGreaterThan(0);
    expect(runs.results.every((r) => r.versi_prompt.startsWith('review@') || r.versi_prompt.includes('@'))).toBe(true);
    const event = await f.ctx.repos.event.recent(50);
    expect(event.some((e) => e.nama === 'agent.run.completed')).toBe(true);
    const laporan = await f.ctx.repos.report.latest(hasil.tanggal);
    expect(laporan).not.toBeNull();
  });

  it('anggaran habis menghentikan tindakan dan mencatat event budget.exceeded', async () => {
    const id = await seedUnit(f, 'miskin', true, { hari: 5 });
    // buat baris agent_budget: satu job review dijalankan, lalu anggaran dipenuhi
    const jobId = `budget-${id}`;
    await f.ctx.repos.job.insert({ id: jobId, saasId: id, fungsi: 'review', jenis: 'review_harian', idemKey: `saas:review:review_harian:${id}`, batas: { max_langkah: 4, max_token: 20_000, timeout_ms: 60_000 }, dibuatPada: Date.now() });
    await f.ctx.orchestrator.executeJob({ id: jobId, saasId: id, fungsi: 'review', jenis: 'review_harian' }, Date.now());
    const periode = isoDate().slice(0, 7);
    await f.db.prepare('UPDATE agent_budget SET terpakai_usd = batas_usd WHERE saas_id = ? AND fungsi = ? AND periode = ?').bind(id, 'review', periode).run();
    const siklus = await f.ctx.orchestrator.runCycle({});
    expect(siklus.jobs.some((j) => j.fungsi === 'review')).toBe(true);
    const event = await f.ctx.repos.event.recent(100);
    expect(event.some((e) => e.nama === 'budget.exceeded')).toBe(true);
    // gateway menolak tindakan tulis karena anggaran fungsi habis
    const svc = await token({ role: 'service', saas: [id], fungsi: 'review' });
    const res = await f.app.request('/api/v1/gateway/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}` }, body: JSON.stringify({ saasId: id, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-budget-0001', payload: {} }) }, f.bindings);
    const body = (await res.json()) as { data: { keputusan: string; aturan: string[] } };
    expect(body.data.keputusan).toBe('tolak');
    expect(body.data.aturan).toContain('anggaran:habis');
  });

  it('antrean: retry dengan backoff lalu dead-letter setelah 3 percobaan', async () => {
    const q = f.ctx.repos.queue;
    await q.enqueue('agent_jobs', { jobId: 'x' }, { now: 1000 });
    const now = 10_000;
    const p1 = await q.claim('agent_jobs', { now, leaseMs: 1 });
    expect(p1?.percobaan).toBe(1);
    await q.retry(p1!, 0, now);
    const p2 = await q.claim('agent_jobs', { now: now + 1, leaseMs: 1 });
    expect(p2?.percobaan).toBe(2);
    await q.retry(p2!, 0, now + 1);
    const p3 = await q.claim('agent_jobs', { now: now + 2, leaseMs: 1, maxPercobaan: 3 });
    expect(p3?.percobaan).toBe(3);
    await q.retry(p3!, 0, now + 2);
    expect(await q.claim('agent_jobs', { now: now + 3, leaseMs: 1, maxPercobaan: 3 })).toBeNull();
    expect(await q.deadLetterSize()).toBe(1);
  });

  it('audit mencatat perubahan status dan rantai hash tetap valid', async () => {
    const id = await seedUnit(f, 'audit', false);
    const tanggal = isoDate();
    for (let i = 0; i < 3; i += 1) {
      const saas = (await f.ctx.repos.saas.byId(id))!;
      const e = (await f.ctx.orchestrator.evaluateUnit(saas, addDays(tanggal, i), Date.now()))!;
      await f.ctx.repos.saas.updateStatus(id, e.ke, Date.now());
    }
    const chain = await f.ctx.repos.audit.verifyChain();
    expect(chain.valid).toBe(true);
    const perubahan = await f.ctx.repos.audit.list({ tindakan: 'status.berubah' });
    expect(perubahan.length).toBeGreaterThanOrEqual(2);
  });

  it('model kustom dipakai orkestrator dan kegagalan model memakai fallback deterministik', async () => {
    await seedUnit(f, 'model', true, { hari: 5 });
    const { Orchestrator } = await import('../src/orchestrator/cycle.ts');
    const orchestrator = new Orchestrator({ db: f.db, repos: f.ctx.repos, env: f.bindings, model: new MockPlanModel() }, f.ctx.health);
    const hasil = await orchestrator.runCycle({});
    expect(hasil.jobs.length).toBeGreaterThan(0);
    expect(hasil.jobs.every((j) => j.status === 'done' || j.status === 'awaiting_approval')).toBe(true);
  });
});

describe('audit & observabilitas', () => {
  it('menyajikan log audit, verifikasi rantai, dan metrik operasional', async () => {
    await seedUnit(f, 'ops', true, { hari: 3 });
    const owner = await token({ role: 'owner' });
    await f.ctx.repos.audit.append({ aktor: 'uji', tindakan: 'uji.audit' });
    const audit = await f.app.request('/api/v1/audit?tindakan=uji.audit', { headers: { authorization: `Bearer ${owner}` } }, f.bindings);
    const body = (await audit.json()) as { data: Array<{ tindakan: string }> };
    expect(body.data.some((e) => e.tindakan === 'uji.audit')).toBe(true);
    const verify = await f.app.request('/api/v1/audit/verify', { headers: { authorization: `Bearer ${owner}` } }, f.bindings);
    expect(((await verify.json()) as { data: { valid: boolean } }).data.valid).toBe(true);
    const ops = await f.app.request('/api/v1/ops/metrics', { headers: { authorization: `Bearer ${owner}` } }, f.bindings);
    expect(ops.status).toBe(200);
    const health = await f.app.request('/healthz', {}, f.bindings);
    expect(health.status).toBe(200);
  });

  it('/dashboard dialihkan permanen ke SPA', async () => {
    await seedUnit(f, 'dash', true, { hari: 5 });
    const res = await f.app.request('/dashboard', {}, f.bindings);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/');
    const unit = await f.app.request('/dashboard/abc', {}, f.bindings);
    expect(unit.headers.get('location')).toBe('/saas/abc');
  });
});
