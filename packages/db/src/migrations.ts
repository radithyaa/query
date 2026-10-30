/**
 * Migrasi D1 ditulis sebagai SQL murni (Drizzle dikelola sebagai sumber kebenaran
 * skema TypeScript pada `schema.ts`). Dijalankan lewat `wrangler d1 execute --file`.
 */
export interface Migration {
  tag: string;
  sql: string;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS saas_unit (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aktif'
    CHECK (status IN ('aktif','pengawasan','intervensi','percobaan','usulan_sunset','dalam_sunset','dihentikan','diarsipkan')),
  status_sejak INTEGER NOT NULL,
  config TEXT NOT NULL CHECK (json_valid(config)),
  dibuat_pada INTEGER NOT NULL,
  repo TEXT,
  akun_toko TEXT,
  akun_sosial TEXT,
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS connector (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  jenis TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  terakhir_sehat INTEGER,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  utama INTEGER NOT NULL DEFAULT 0,
  UNIQUE (saas_id, jenis)
);
CREATE INDEX IF NOT EXISTS idx_connector_saas ON connector (saas_id);

CREATE TABLE IF NOT EXISTS metric_daily (
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  tanggal TEXT NOT NULL,
  skema_versi INTEGER NOT NULL,
  metrik TEXT NOT NULL CHECK (json_valid(metrik)),
  diterima_pada INTEGER NOT NULL,
  PRIMARY KEY (saas_id, tanggal)
);

CREATE TABLE IF NOT EXISTS agent_job (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  fungsi TEXT NOT NULL,
  idem_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  batas TEXT NOT NULL CHECK (json_valid(batas)),
  dibuat_pada INTEGER NOT NULL,
  jenis TEXT NOT NULL DEFAULT 'harian',
  mulai INTEGER,
  selesai INTEGER,
  hasil TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_saas ON agent_job (saas_id, fungsi, status);
CREATE INDEX IF NOT EXISTS idx_job_status ON agent_job (status, dibuat_pada);

CREATE TABLE IF NOT EXISTS agent_run (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES agent_job(id),
  percobaan_ke INTEGER NOT NULL DEFAULT 1,
  versi_prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  mulai INTEGER NOT NULL,
  selesai INTEGER,
  status TEXT NOT NULL,
  token_masuk INTEGER,
  token_keluar INTEGER,
  biaya_usd REAL,
  keluaran_ref TEXT,
  ringkasan TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_job ON agent_run (job_id);

CREATE TABLE IF NOT EXISTS agent_memory (
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  fungsi TEXT NOT NULL,
  ringkasan TEXT NOT NULL,
  diperbarui_pada INTEGER NOT NULL,
  PRIMARY KEY (saas_id, fungsi)
);

CREATE TABLE IF NOT EXISTS agent_budget (
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  fungsi TEXT NOT NULL,
  periode TEXT NOT NULL,
  batas_usd REAL NOT NULL,
  terpakai_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (saas_id, fungsi, periode)
);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  job_id TEXT REFERENCES agent_job(id),
  jenis TEXT NOT NULL,
  ringkasan_dampak TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'menunggu',
  kedaluwarsa INTEGER NOT NULL,
  diputuskan_oleh TEXT,
  diputuskan_pada INTEGER,
  dibuat_pada INTEGER NOT NULL DEFAULT 0,
  dibuka_pada INTEGER,
  catatan TEXT,
  fungsi TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval (status, kedaluwarsa);
CREATE INDEX IF NOT EXISTS idx_approval_saas ON approval (saas_id, status);

CREATE TABLE IF NOT EXISTS health_evaluation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  tanggal TEXT NOT NULL,
  skor REAL NOT NULL,
  komponen TEXT NOT NULL CHECK (json_valid(komponen)),
  data_cukup INTEGER NOT NULL,
  status_lama TEXT NOT NULL,
  status_baru TEXT NOT NULL,
  alasan TEXT NOT NULL DEFAULT '',
  tanggal_baru TEXT,
  evaluasi_pulih TEXT NOT NULL DEFAULT '[]',
  UNIQUE (saas_id, tanggal)
);
CREATE INDEX IF NOT EXISTS idx_eval_saas ON health_evaluation (saas_id, tanggal);

CREATE TABLE IF NOT EXISTS sunset_case (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  paket_bukti TEXT NOT NULL CHECK (json_valid(paket_bukti)),
  tahap TEXT NOT NULL,
  keputusan TEXT,
  diputuskan_oleh TEXT,
  diputuskan_pada INTEGER,
  dibuat_pada INTEGER NOT NULL DEFAULT 0,
  tenggat_baru TEXT,
  catatan TEXT
);
CREATE INDEX IF NOT EXISTS idx_sunset_saas ON sunset_case (saas_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waktu INTEGER NOT NULL,
  aktor TEXT NOT NULL,
  saas_id TEXT,
  tindakan TEXT NOT NULL,
  masukan TEXT,
  keluaran TEXT,
  hash_sebelumnya TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_waktu ON audit_log (waktu);
CREATE INDEX IF NOT EXISTS idx_audit_saas ON audit_log (saas_id, waktu);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log bersifat append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log bersifat append-only'); END;

CREATE TABLE IF NOT EXISTS content_item (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  kanal TEXT NOT NULL,
  status TEXT NOT NULL,
  judul TEXT NOT NULL,
  body TEXT NOT NULL,
  hashtag TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hashtag)),
  alt_text TEXT,
  jadwal TEXT,
  skrip_video TEXT,
  pemeriksaan_klaim TEXT,
  run_id TEXT,
  dibuat_pada INTEGER NOT NULL,
  metrik TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_saas ON content_item (saas_id, dibuat_pada);

CREATE TABLE IF NOT EXISTS review (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  review_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  teks TEXT NOT NULL,
  versi_aplikasi TEXT,
  perangkat TEXT,
  tanggal INTEGER NOT NULL,
  kategori TEXT,
  tema TEXT,
  balasan TEXT,
  status TEXT NOT NULL DEFAULT 'baru',
  run_id TEXT,
  dibuat_pada INTEGER NOT NULL,
  UNIQUE (saas_id, review_id)
);
CREATE INDEX IF NOT EXISTS idx_review_saas ON review (saas_id, tanggal);
CREATE INDEX IF NOT EXISTS idx_review_tema ON review (saas_id, tema);

CREATE TABLE IF NOT EXISTS pull_request_ref (
  id TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL REFERENCES saas_unit(id),
  nomor INTEGER NOT NULL,
  repo TEXT NOT NULL,
  judul TEXT NOT NULL,
  url TEXT,
  issue_asal TEXT,
  status TEXT NOT NULL,
  ci_lulus INTEGER,
  penyetuju TEXT,
  ringkasan TEXT,
  run_id TEXT,
  dibuat_pada INTEGER NOT NULL,
  UNIQUE (saas_id, repo, nomor)
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  saas_id TEXT,
  run_id TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  waktu INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_waktu ON event_log (waktu);

CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  terlihat_pada INTEGER,
  tersedia_pada INTEGER NOT NULL,
  percobaan INTEGER NOT NULL DEFAULT 0,
  dibuat_pada INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_topic ON job_queue (topic, tersedia_pada);

CREATE TABLE IF NOT EXISTS idempotency_key (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT,
  dibuat_pada INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_state (
  idem_key TEXT PRIMARY KEY,
  saas_id TEXT NOT NULL,
  fungsi TEXT NOT NULL,
  jenis TEXT NOT NULL,
  langkah INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'baru',
  konteks TEXT NOT NULL DEFAULT '{}',
  dibuat_pada INTEGER NOT NULL,
  diperbarui_pada INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kill_switch_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cakupan TEXT NOT NULL,
  saas_id TEXT,
  aktif INTEGER NOT NULL,
  alasan TEXT NOT NULL,
  aktor TEXT NOT NULL,
  waktu INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS golden_case (
  id TEXT PRIMARY KEY,
  jenis TEXT NOT NULL,
  masukan TEXT NOT NULL,
  harapan TEXT NOT NULL,
  aktif INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kanal TEXT NOT NULL,
  ke TEXT NOT NULL,
  judul TEXT NOT NULL,
  isi TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'terkirim',
  dibuat_pada INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY,
  periode TEXT NOT NULL,
  saas_id TEXT,
  isi TEXT NOT NULL CHECK (json_valid(isi)),
  dibuat_pada INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_input (
  idem_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  dibuat_pada INTEGER NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [{ tag: '0001_init', sql: SCHEMA_SQL }];
