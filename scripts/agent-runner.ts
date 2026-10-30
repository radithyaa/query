/**
 * Menjalankan agen dari CLI (§3.3). Berguna untuk mencoba agen tertentu tanpa
 * menunggu siklus: `npm run agent:run -- --saas laporanku --fungsi review`.
 *
 * Semua tool tulis tetap melewati policy gateway; mode mock tidak memanggil
 * jaringan sehingga aman dijalankan kapan saja.
 */
import { FUNGSI, type Fungsi } from '@portfolio/shared';
import { DEFAULT_JOB_BATAS } from '@portfolio/shared';
import { arg, bukaAplikasi, flag, loadDotEnv } from './lib.ts';
import { jobIdemKey } from '../apps/api/src/orchestrator/cycle.ts';

loadDotEnv();

function parseFungsi(value: string | undefined): Fungsi | null {
  return value && (FUNGSI as readonly string[]).includes(value) ? (value as Fungsi) : null;
}

const app = await bukaAplikasi();
const { repos, orchestrator } = app.ctx;

const slug = arg('saas');
const fungsi = parseFungsi(arg('fungsi'));
const tanggal = arg('tanggal') ?? new Date().toISOString().slice(0, 10);

if (flag('cycle')) {
  const hasil = await orchestrator.runCycle({ tanggal, skipJobs: flag('queued') });
  console.log(JSON.stringify({ level: 'info', msg: 'siklus.selesai', ...hasil }, null, 2));
  app.db.close();
  process.exit(0);
}

if (!slug || !fungsi) {
  console.error('Pemakaian: npm run agent:run -- --saas <slug> --fungsi <review|support|promosi|kode|parent> [--tanggal YYYY-MM-DD]');
  console.error('Atau:      npm run agent:run -- --cycle [--queued]');
  app.db.close();
  process.exit(1);
}

const saas = await repos.saas.bySlug(slug);
if (!saas) {
  console.error(JSON.stringify({ level: 'error', msg: 'saas.tidak_ditemukan', slug }));
  app.db.close();
  process.exit(1);
}

const jenis = fungsi === 'parent' ? 'parent_harian' : (`${fungsi}_harian` as const);
const idemKey = jobIdemKey(saas.id, fungsi, jenis, tanggal);
const dibuat = await repos.job.insert({ id: `cli:${idemKey}`, saasId: saas.id, fungsi, jenis, idemKey, batas: DEFAULT_JOB_BATAS, dibuatPada: Date.now() });
const job = await repos.job.byIdemKey(idemKey);
if (!job) {
  console.error(JSON.stringify({ level: 'error', msg: 'job.tidak_terbuat', idemKey }));
  app.db.close();
  process.exit(1);
}
if (!dibuat) {
  console.log(JSON.stringify({ level: 'info', msg: 'job.sudah_ada', job_id: job.id, status: job.status }));
}

try {
  const hasil = await orchestrator.executeJob(job, Date.now());
  console.log(JSON.stringify({ level: 'info', msg: 'agent.selesai', saas: slug, fungsi, job_id: job.id, ...hasil }, null, 2));
  const approvals = await repos.approval.list({ status: 'menunggu', saasId: saas.id, limit: 10 });
  if (approvals.length > 0) {
    console.log(JSON.stringify({ level: 'info', msg: 'approval.menunggu', daftar: approvals.map((a) => ({ id: a.id, jenis: a.jenis, ringkasan: a.ringkasanDampak })) }, null, 2));
  }
} finally {
  app.db.close();
}
