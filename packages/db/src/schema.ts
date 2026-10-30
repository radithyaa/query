/**
 * Definisi tabel Drizzle untuk D1 (dokumentasi skema + tipe). Migrasi SQL aktual
 * ada di `migrations.ts`; kolom di sini mencerminkan tabel yang sama.
 */
import { integer, real, sqliteTable, text, primaryKey, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const saasUnit = sqliteTable('saas_unit', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  nama: text('nama').notNull(),
  status: text('status').notNull().default('aktif'),
  statusSejak: integer('status_sejak').notNull(),
  config: text('config').notNull(),
  dibuatPada: integer('dibuat_pada').notNull(),
  repo: text('repo'),
  akunToko: text('akun_toko'),
  akunSosial: text('akun_sosial'),
  paused: integer('paused').notNull().default(0),
});

export const connector = sqliteTable(
  'connector',
  {
    id: text('id').primaryKey(),
    saasId: text('saas_id').notNull(),
    jenis: text('jenis').notNull(),
    secretRef: text('secret_ref').notNull(),
    terakhirSehat: integer('terakhir_sehat'),
    detail: text('detail').notNull().default('{}'),
    utama: integer('utama').notNull().default(0),
  },
  (t) => [uniqueIndex('connector_saas_jenis').on(t.saasId, t.jenis)],
);

export const metricDaily = sqliteTable(
  'metric_daily',
  {
    saasId: text('saas_id').notNull(),
    tanggal: text('tanggal').notNull(),
    skemaVersi: integer('skema_versi').notNull(),
    metrik: text('metrik').notNull(),
    diterimaPada: integer('diterima_pada').notNull(),
  },
  (t) => [primaryKey({ columns: [t.saasId, t.tanggal] })],
);

export const agentJob = sqliteTable(
  'agent_job',
  {
    id: text('id').primaryKey(),
    saasId: text('saas_id').notNull(),
    fungsi: text('fungsi').notNull(),
    idemKey: text('idem_key').notNull().unique(),
    status: text('status').notNull(),
    batas: text('batas').notNull(),
    dibuatPada: integer('dibuat_pada').notNull(),
    jenis: text('jenis').notNull().default('harian'),
    mulai: integer('mulai'),
    selesai: integer('selesai'),
    hasil: text('hasil'),
  },
  (t) => [index('idx_job_saas').on(t.saasId, t.fungsi, t.status)],
);

export const agentRun = sqliteTable('agent_run', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  percobaanKe: integer('percobaan_ke').notNull().default(1),
  versiPrompt: text('versi_prompt').notNull(),
  model: text('model').notNull(),
  mulai: integer('mulai').notNull(),
  selesai: integer('selesai'),
  status: text('status').notNull(),
  tokenMasuk: integer('token_masuk'),
  tokenKeluar: integer('token_keluar'),
  biayaUsd: real('biaya_usd'),
  keluaranRef: text('keluaran_ref'),
  ringkasan: text('ringkasan'),
});

export const agentMemory = sqliteTable(
  'agent_memory',
  {
    saasId: text('saas_id').notNull(),
    fungsi: text('fungsi').notNull(),
    ringkasan: text('ringkasan').notNull(),
    diperbaruiPada: integer('diperbarui_pada').notNull(),
  },
  (t) => [primaryKey({ columns: [t.saasId, t.fungsi] })],
);

export const agentBudget = sqliteTable(
  'agent_budget',
  {
    saasId: text('saas_id').notNull(),
    fungsi: text('fungsi').notNull(),
    periode: text('periode').notNull(),
    batasUsd: real('batas_usd').notNull(),
    terpakaiUsd: real('terpakai_usd').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.saasId, t.fungsi, t.periode] })],
);

export const approval = sqliteTable(
  'approval',
  {
    id: text('id').primaryKey(),
    saasId: text('saas_id').notNull(),
    jobId: text('job_id'),
    jenis: text('jenis').notNull(),
    ringkasanDampak: text('ringkasan_dampak').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('menunggu'),
    kedaluwarsa: integer('kedaluwarsa').notNull(),
    diputuskanOleh: text('diputuskan_oleh'),
    diputuskanPada: integer('diputuskan_pada'),
    dibuatPada: integer('dibuat_pada').notNull().default(0),
    dibukaPada: integer('dibuka_pada'),
    catatan: text('catatan'),
    fungsi: text('fungsi'),
  },
  (t) => [index('idx_approval_status').on(t.status, t.kedaluwarsa)],
);

export const healthEvaluation = sqliteTable(
  'health_evaluation',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saasId: text('saas_id').notNull(),
    tanggal: text('tanggal').notNull(),
    skor: real('skor').notNull(),
    komponen: text('komponen').notNull(),
    dataCukup: integer('data_cukup').notNull(),
    statusLama: text('status_lama').notNull(),
    statusBaru: text('status_baru').notNull(),
    alasan: text('alasan').notNull().default(''),
  },
  (t) => [index('idx_eval_saas').on(t.saasId, t.tanggal)],
);

export const sunsetCase = sqliteTable('sunset_case', {
  id: text('id').primaryKey(),
  saasId: text('saas_id').notNull(),
  paketBukti: text('paket_bukti').notNull(),
  tahap: text('tahap').notNull(),
  keputusan: text('keputusan'),
  diputuskanOleh: text('diputuskan_oleh'),
  diputuskanPada: integer('diputuskan_pada'),
  dibuatPada: integer('dibuat_pada').notNull().default(0),
  tenggatBaru: text('tenggat_baru'),
  catatan: text('catatan'),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  waktu: integer('waktu').notNull(),
  aktor: text('aktor').notNull(),
  saasId: text('saas_id'),
  tindakan: text('tindakan').notNull(),
  masukan: text('masukan'),
  keluaran: text('keluaran'),
  hashSebelumnya: text('hash_sebelumnya'),
  hash: text('hash'),
});

export const contentItem = sqliteTable('content_item', {
  id: text('id').primaryKey(),
  saasId: text('saas_id').notNull(),
  kanal: text('kanal').notNull(),
  status: text('status').notNull(),
  judul: text('judul').notNull(),
  body: text('body').notNull(),
  hashtag: text('hashtag').notNull().default('[]'),
  altText: text('alt_text'),
  jadwal: text('jadwal'),
  skripVideo: text('skrip_video'),
  pemeriksaanKlaim: text('pemeriksaan_klaim'),
  runId: text('run_id'),
  dibuatPada: integer('dibuat_pada').notNull(),
  metrik: text('metrik'),
});

export const review = sqliteTable('review', {
  id: text('id').primaryKey(),
  saasId: text('saas_id').notNull(),
  reviewId: text('review_id').notNull(),
  rating: integer('rating').notNull(),
  teks: text('teks').notNull(),
  versiAplikasi: text('versi_aplikasi'),
  perangkat: text('perangkat'),
  tanggal: integer('tanggal').notNull(),
  kategori: text('kategori'),
  tema: text('tema'),
  balasan: text('balasan'),
  status: text('status').notNull().default('baru'),
  runId: text('run_id'),
  dibuatPada: integer('dibuat_pada').notNull(),
});

export const pullRequestRef = sqliteTable('pull_request_ref', {
  id: text('id').primaryKey(),
  saasId: text('saas_id').notNull(),
  nomor: integer('nomor').notNull(),
  repo: text('repo').notNull(),
  judul: text('judul').notNull(),
  url: text('url'),
  issueAsal: text('issue_asal'),
  status: text('status').notNull(),
  ciLulus: integer('ci_lulus'),
  penyetuju: text('penyetuju'),
  ringkasan: text('ringkasan'),
  runId: text('run_id'),
  dibuatPada: integer('dibuat_pada').notNull(),
});

export const eventLog = sqliteTable('event_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nama: text('nama').notNull(),
  saasId: text('saas_id'),
  runId: text('run_id'),
  payload: text('payload').notNull(),
  waktu: integer('waktu').notNull(),
});

export const schema = {
  saasUnit,
  connector,
  metricDaily,
  agentJob,
  agentRun,
  agentMemory,
  agentBudget,
  approval,
  healthEvaluation,
  sunsetCase,
  auditLog,
  contentItem,
  review,
  pullRequestRef,
  eventLog,
};
