/**
 * Smoke test runtime Node (§9.1, Fase 1 & 3): menjalankan aplikasi pada database
 * sementara — migrasi → seed sintetis → siklus harian → rute HTTP → persetujuan
 * → kill switch → sunset. Gagal (exit 1) bila salah satu pemeriksaan tidak sesuai.
 *
 * Tidak memanggil jaringan: konektor mock dan model deterministik.
 */
import { LocalDatabase, migrate, createRepos } from '@portfolio/db';
import { buildApp } from '../apps/api/src/app.ts';
import { createWorker } from '../apps/api/src/index.ts';
import { apiContext } from '../apps/api/src/context.ts';
import { buatRepositori, readEnv, type Bindings } from '../apps/api/src/env.ts';
import { signHs256, type Claims } from '../apps/api/src/auth.ts';
import { addDays, isoDate, randomId, type DailyMetric } from '@portfolio/shared';
import { portfolioSummary } from '../apps/api/src/services/summary.ts';

const hasil: Array<{ cek: string; ok: boolean; detail?: unknown }> = [];
function cek(nama: string, ok: boolean, detail?: unknown): void {
  hasil.push({ cek: nama, ok, ...(ok ? {} : { detail }) });
}

const SEKRET = 'smoke-test-secret-0123456789';
const HARI = 40;

function metrik(tanggal: string, i: number, sehat: boolean): DailyMetric {
  return {
    skema_versi: 1,
    tanggal,
    mata_uang: 'IDR',
    bisnis: { mrr: sehat ? 3_000_000 + i * 20_000 : 4_000_000 - i * 25_000, pelanggan_aktif: 90, signup_baru: 5, churn_bulanan_persen: sehat ? 2.1 : 7.5 },
    produk: { dau: 300, mau: 900, aktivasi_persen: sehat ? 45 : 26 },
    toko_aplikasi: { rating_rata2: sehat ? 4.5 : 3.1, ulasan_baru: 5, ulasan_negatif: sehat ? 1 : 4 },
    stabilitas: { error_rate_persen: sehat ? 0.3 : 2.8, uptime_persen: sehat ? 99.9 : 98.4, bug_terbuka: sehat ? 3 : 11 },
    biaya: { infra: 500_000, agen: 80_000 },
  };
}

async function token(claims: Omit<Claims, 'exp' | 'iat'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ ...claims, iat: now, exp: now + 3600 }, SEKRET);
}

const db = new LocalDatabase(':memory:');
const diterapkan = await migrate(db);
cek('migrasi dijalankan', diterapkan.includes('0001_init'), diterapkan);

const bindings: Bindings = readEnv({ ...process.env, DB: db, MOCK_CONNECTORS: 'true', JWT_SECRET: SEKRET, APP_NAME: 'Smoke Portfolio' });
bindings.repos = buatRepositori(db);
const ctx = apiContext(bindings);
const { repos, orchestrator } = ctx;

// dua SaaS Unit: satu sehat, satu menurun tajam
const sehatId = randomId();
const turunId = randomId();
const mulai = addDays(isoDate(), -(HARI - 1));
for (const [id, slug, sehat] of [
  [sehatId, 'sehat', true],
  [turunId, 'turun', false],
] as const) {
  await repos.saas.insert({ id, slug, nama: slug === 'sehat' ? 'SaaS Sehat' : 'SaaS Turun', status: 'aktif', config: { anggaran_bulanan_usd: { review: 15, support: 10, promosi: 20, kode: 30, token: 10 }, kriteria_bangkit: { jendela_evaluasi_hari: 28, masa_percobaan_hari: 30, syarat: [{ metrik: 'pertumbuhan_mrr_persen', minimal: 10 }] } }, dibuatPada: Date.now(), repo: `org/${slug}` });
  for (const [jenis, utama] of [['billing', true], ['analytics', true], ['play', true]] as const) {
    await repos.saas.upsertConnector({ id: randomId(), saasId: id, jenis, secretRef: `secret://${jenis}`, detail: {}, utama, terakhirSehat: Date.now() });
  }
  for (let i = 0; i < HARI; i += 1) {
    const t = addDays(mulai, i);
    await repos.metric.upsert({ saas_id: id, tanggal: t, skema_versi: 1, metrik: metrik(t, i, sehat), diterima_pada: Date.parse(`${t}T01:00:00Z`) });
  }
}
cek('seed metrik 40 hari', (await repos.metric.list(sehatId)).length === HARI);

const hariIni = isoDate();
const evaluasiPertama = (await orchestrator.evaluateUnit((await repos.saas.byId(turunId))!, hariIni, Date.now()))!;
await repos.saas.updateStatus(turunId, evaluasiPertama.ke, Date.now());
// siklus evaluasi: aktif → pengawasan (2 evaluasi < 70) → intervensi (2 evaluasi < 55)
cek('evaluasi memakai ambang pengawasan (70)', evaluasiPertama.skor > 0 && evaluasiPertama.skor < 70, evaluasiPertama);
const evaluasiKedua = await orchestrator.evaluateUnit((await repos.saas.byId(turunId))!, addDays(hariIni, 1), Date.now());
await repos.saas.updateStatus(turunId, evaluasiKedua!.ke, Date.now());
cek('dua evaluasi di bawah 70 → pengawasan', evaluasiKedua?.ke === 'pengawasan', evaluasiKedua);
const evaluasiKetiga = await orchestrator.evaluateUnit((await repos.saas.byId(turunId))!, addDays(hariIni, 2), Date.now());
await repos.saas.updateStatus(turunId, evaluasiKetiga!.ke, Date.now());
const evaluasiKeempat = await orchestrator.evaluateUnit((await repos.saas.byId(turunId))!, addDays(hariIni, 3), Date.now());
await repos.saas.updateStatus(turunId, evaluasiKeempat!.ke, Date.now());
cek('dua evaluasi di bawah 55 → intervensi', evaluasiKeempat?.ke === 'intervensi', evaluasiKeempat);
const rencana = await repos.approval.list({ status: 'menunggu', saasId: turunId });
cek('intervensi meminta persetujuan rencana pemulihan (rc_plan)', rencana.some((a) => a.jenis === 'rc_plan'), rencana.map((a) => a.jenis));
const planApproval = rencana.find((a) => a.jenis === 'rc_plan')!;
const setujuPlan = await orchestrator.decideApproval(planApproval.id, 'disetujui', 'owner:uji');
const statusSetelahPlan = (await repos.saas.byId(turunId))!.status;
cek('menyetujui rc_plan memindahkan ke masa percobaan', setujuPlan.ok && statusSetelahPlan === 'percobaan', { hasil: setujuPlan, status: statusSetelahPlan });
const sehatEval = await orchestrator.evaluateUnit((await repos.saas.byId(sehatId))!, hariIni, Date.now());
cek('SaaS sehat tetap aktif', sehatEval?.ke === 'aktif', sehatEval);

// siklus penuh: job dijadwalkan dan dijalankan, laporan dibuat
const siklus = await orchestrator.runCycle({ now: Date.now() });
cek('siklus menjadwalkan job', siklus.jobsQueued.length > 0, siklus.jobsQueued);
cek('siklus menjalankan job tanpa dead-letter', siklus.jobs.every((j) => j.status !== 'dead'), siklus.jobs);
cek('laporan harian dibuat', siklus.reports.length === 1, siklus.reports);
const jobSelesai = await repos.db.prepare("SELECT COUNT(*) AS n FROM agent_job WHERE status IN ('done','awaiting_approval')").first<{ n: number }>();
cek('ada job selesai / menunggu persetujuan', Number(jobSelesai?.n ?? 0) > 0, jobSelesai);
const run = await repos.db.prepare('SELECT COUNT(*) AS n FROM agent_run').first<{ n: number }>();
cek('agent_run tercatat (versi_prompt, model, biaya)', Number(run?.n ?? 0) > 0, run);

// idempoten: siklus kedua di tanggal yang sama tidak menggandakan job/laporan
const jobSebelum = await repos.db.prepare('SELECT COUNT(*) AS n FROM agent_job').first<{ n: number }>();
const siklus2 = await orchestrator.runCycle({ now: Date.now(), skipJobs: true });
const jobSesudah = await repos.db.prepare('SELECT COUNT(*) AS n FROM agent_job').first<{ n: number }>();
cek('siklus ulang idempoten', Number(jobSebelum?.n) === Number(jobSesudah?.n) && siklus2.reports.length === 0, { sebelum: jobSebelum, sesudah: jobSesudah });

// rute HTTP
const app = buildApp();
const owner = await token({ sub: 'owner-1', role: 'owner', saas: [], email: 'owner@contoh.id', mfa: true });
const operator = await token({ sub: 'op-1', role: 'operator', saas: [sehatId], email: 'op@contoh.id' });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const health = await app.request('/healthz', {}, bindings);
const healthBody = (await health.json()) as { ok: boolean; audit_chain: { valid: boolean } };
cek('GET /healthz ok dan rantai audit valid', health.status === 200 && healthBody.ok && healthBody.audit_chain.valid, healthBody);

const tanpaToken = await app.request('/api/v1/portfolio/summary', {}, bindings);
cek('rute terproteksi menolak tanpa token', tanpaToken.status === 401, tanpaToken.status);

const summaryRes = await app.request('/api/v1/portfolio/summary', { headers: auth(owner) }, bindings);
const summary = (await summaryRes.json()) as { data: { total: number; units: Array<{ id: string; skor: number | null }> } };
cek('GET /api/v1/portfolio/summary', summaryRes.status === 200 && summary.data.total === 2 && summary.data.units.some((u) => u.skor !== null), summary.data);

const summaryOperator = await app.request('/api/v1/portfolio/summary', { headers: auth(operator) }, bindings);
const bodyOperator = (await summaryOperator.json()) as { data: { total: number; units: Array<{ id: string }> } };
cek('operator hanya melihat SaaS yang ditugaskan', bodyOperator.data.total === 1 && bodyOperator.data.units[0]?.id === sehatId, bodyOperator.data);

const dashboard = await app.request('/assets/tidak-ada.js', {}, bindings);
const worker = createWorker();
const halaman = await worker.fetch(new Request('https://smoke.local/'), bindings, { waitUntil: () => undefined } as never);
cek(
  'GET / menyajikan dashboard (entri SPA; aset hilang → 404 JSON)',
  halaman.status === 200 && dashboard.status === 404,
  { worker: halaman.status, asetHilang: dashboard.status },
);

const dashboardLama = await app.request('/dashboard', {}, bindings);
cek('GET /dashboard dialihkan ke SPA', dashboardLama.status === 301 && dashboardLama.headers.get('location') === '/', dashboardLama.status);

const statusRes = await app.request(`/api/v1/saas/${turunId}/status`, { headers: auth(owner) }, bindings);
const statusBody = (await statusRes.json()) as { data: { status: string; evaluasi: unknown[] } };
cek('GET /api/v1/saas/:id/status', statusRes.status === 200 && statusBody.data.status === 'percobaan' && statusBody.data.evaluasi.length > 0, statusBody.data.status);

const ingest = await app.request(
  `/api/v1/saas/${sehatId}/metrics`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token({ sub: 'connector', role: 'connector', saas: [sehatId], email: 'konektor@contoh.id' })}` },
    body: JSON.stringify(metrik(addDays(hariIni, 2), HARI + 2, true)),
  },
  bindings,
);
cek('POST /api/v1/saas/:id/metrics menerima metrik berskema', ingest.status === 202, await ingest.text());
const ingestSalah = await app.request(
  `/api/v1/saas/${sehatId}/metrics`,
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token({ sub: 'connector', role: 'connector', saas: [sehatId] })}` }, body: JSON.stringify({ skema_versi: 9 }) },
  bindings,
);
cek('metrik tak berskema ditolak 400', ingestSalah.status === 400, ingestSalah.status);

// policy gateway: otonomi draf → perlu persetujuan + baris approval
const gatewayRes = await app.request(
  '/api/v1/gateway/check',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token({ sub: 'svc', role: 'service', saas: [sehatId], fungsi: 'review', email: 'svc@contoh.id' })}` },
    body: JSON.stringify({ saasId: sehatId, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'smoke-gw-0001', payload: { review_id: 'r-1', teks: 'Terima kasih' }, ringkasan_dampak: 'Balas ulasan pujian' }),
  },
  bindings,
);
const gateway = (await gatewayRes.json()) as { data: { keputusan: string; approval_id: string | null } };
cek('gateway membuat permintaan persetujuan pada tingkat draf', gatewayRes.status === 200 && gateway.data.keputusan === 'perlu_persetujuan' && Boolean(gateway.data.approval_id), gateway.data);

const gatewayTolak = await app.request(
  '/api/v1/gateway/check',
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token({ sub: 'svc', role: 'service', saas: [sehatId], fungsi: 'review' })}` }, body: JSON.stringify({ saasId: sehatId, fungsi: 'review', tindakan: 'merge_pr', idemKey: 'smoke-gw-0002', payload: {} }) },
  bindings,
);
const tolak = (await gatewayTolak.json()) as { data: { keputusan: string; aturan: string[] } };
cek('matriks izin menolak merge_pr untuk fungsi review', tolak.data.keputusan === 'tolak' && tolak.data.aturan.includes('izin:matriks'), tolak.data);

const approvalId = gateway.data.approval_id!;
const tanpaIdem = await app.request(`/api/v1/approvals/${approvalId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(owner) }, body: JSON.stringify({ keputusan: 'setujui' }) }, bindings);
cek('keputusan tanpa Idempotency-Key ditolak', tanpaIdem.status === 400, tanpaIdem.status);

const keputusan = await app.request(
  `/api/v1/approvals/${approvalId}/decision`,
  { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'smoke-decide-0001', ...auth(owner) }, body: JSON.stringify({ keputusan: 'setujui', catatan: 'ok' }) },
  bindings,
);
const keputusanBody = (await keputusan.json()) as { data: { status: string } };
cek('pemilik menyetujui persetujuan', keputusan.status === 200 && keputusanBody.data.status === 'disetujui', keputusanBody);
const keputusanUlang = await app.request(
  `/api/v1/approvals/${approvalId}/decision`,
  { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'smoke-decide-0002', ...auth(owner) }, body: JSON.stringify({ keputusan: 'tolak' }) },
  bindings,
);
cek('keputusan ganda ditolak (409)', keputusanUlang.status === 409, keputusanUlang.status);

// kill switch per SaaS: gateway menolak semua tindakan tulis
const kill = await app.request(
  '/api/v1/killswitch',
  { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'smoke-kill-0001', ...auth(owner) }, body: JSON.stringify({ aktif: true, saas_id: sehatId, alasan: 'uji smoke' }) },
  bindings,
);
cek('POST /api/v1/killswitch per SaaS', kill.status === 200, kill.status);
const gatewayKill = await app.request(
  '/api/v1/gateway/check',
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token({ sub: 'svc', role: 'service', saas: [sehatId], fungsi: 'review' })}` }, body: JSON.stringify({ saasId: sehatId, fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'smoke-gw-0003', payload: {} }) },
  bindings,
);
const killBody = (await gatewayKill.json()) as { data: { keputusan: string; aturan: string[] } };
cek('kill switch menolak tindakan tulis', killBody.data.keputusan === 'tolak' && killBody.data.aturan.includes('killswitch:saas'), killBody.data);

const resume = await app.request('/api/v1/saas/' + sehatId + '/resume', { method: 'POST', headers: { 'Idempotency-Key': 'smoke-resume-01', ...auth(owner) } }, bindings);
cek('POST /saas/:id/resume', resume.status === 200, resume.status);
const killOff = await app.request(
  '/api/v1/killswitch',
  { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'smoke-kill-0002', ...auth(owner) }, body: JSON.stringify({ aktif: false, saas_id: sehatId, alasan: 'uji selesai' }) },
  bindings,
);
cek('kill switch dapat dicabut', killOff.status === 200, killOff.status);

// sunset: usulan dibuat oleh health engine, keputusan harus pemilik + MFA
const kasusId = randomId();
await repos.sunset.create({ id: kasusId, saasId: turunId, paketBukti: { uji: true }, tahap: 'diusulkan', dibuatPada: Date.now() });
await repos.saas.updateStatus(turunId, 'usulan_sunset', Date.now());
const sunsetTanpaMfa = await app.request(
  `/api/v1/sunset/${kasusId}/decision`,
  { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'smoke-sunset-001', ...auth(operator) }, body: JSON.stringify({ keputusan: 'setujui', mfa_token: 'dev-123456' }) },
  bindings,
);
cek('sunset oleh operator ditolak', sunsetTanpaMfa.status === 403, sunsetTanpaMfa.status);
const sunset = await app.request(
  `/api/v1/sunset/${kasusId}/decision`,
  { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'smoke-sunset-002', ...auth(owner) }, body: JSON.stringify({ keputusan: 'setujui', mfa_token: 'dev-123456' }) },
  bindings,
);
const sunsetBody = (await sunset.json()) as { data: { tahap: string; status: string } };
cek('pemilik menyetujui sunset → dalam_sunset', sunset.status === 200 && sunsetBody.data.status === 'dalam_sunset' && sunsetBody.data.tahap === 'pengumuman', sunsetBody);
const advance = await app.request(`/api/v1/sunset/${kasusId}/advance`, { method: 'POST', headers: { 'Idempotency-Key': 'smoke-sunset-003', ...auth(owner) } }, bindings);
cek('tahap sunset berikutnya', advance.status === 200, await advance.text());

const audit = await app.request('/api/v1/audit?limit=200', { headers: auth(owner) }, bindings);
const auditBody = (await audit.json()) as { data: Array<{ tindakan: string }> };
const verify = await app.request('/api/v1/audit/verify', { headers: auth(owner) }, bindings);
const verifyBody = (await verify.json()) as { data: { valid: boolean; checked: number; rusakPada: number | null } };
cek('audit berisi jejak tindakan', auditBody.data.length > 0 && ['gateway.balas_ulasan', 'approval.disetujui', 'killswitch.aktif', 'sunset.disetujui'].every((t) => auditBody.data.some((e) => e.tindakan === t)), auditBody.data.slice(0, 5).map((e) => e.tindakan));
cek('rantai hash audit valid', verifyBody.data.valid && verifyBody.data.checked > 5, verifyBody.data);

const ops = await app.request('/api/v1/ops/metrics', { headers: auth(owner) }, bindings);
cek('GET /api/v1/ops/metrics', ops.status === 200, ops.status);

const report = await app.request('/api/v1/reports/latest', { headers: auth(owner) }, bindings);
cek('GET /api/v1/reports/latest', report.status === 200, report.status);

const ringkasanSebelum = await portfolioSummary(repos, { now: Date.now() });
await repos.saas.setPaused(sehatId, true);
const ringkasanSesudah = await portfolioSummary(repos, { now: Date.now() });
await repos.saas.setPaused(sehatId, false);
cek(
  'ringkasan portofolio deterministik untuk data yang sama',
  JSON.stringify(ringkasanSebelum.units.map((u) => [u.id, u.skor, u.peringkat])) === JSON.stringify(ringkasanSesudah.units.map((u) => [u.id, u.skor, u.peringkat])),
  { sebelum: ringkasanSebelum.units.length },
);

void createRepos;
db.close();

const gagal = hasil.filter((h) => !h.ok);
for (const h of hasil) console.log(`${h.ok ? '✔' : '✖'} ${h.cek}${h.ok ? '' : ` → ${JSON.stringify(h.detail)}`}`);
console.log(JSON.stringify({ level: gagal.length ? 'error' : 'info', msg: 'smoke.selesai', lulus: hasil.length - gagal.length, total: hasil.length }));
process.exit(gagal.length === 0 ? 0 : 1);
