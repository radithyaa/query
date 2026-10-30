/**
 * Konfigurasi lingkungan untuk aplikasi Hono. Semua nilai berasal dari
 * `wrangler.jsonc` (vars) atau rahasia Workers; tidak ada nilai rahasia di kode.
 */
import { z } from 'zod';
import { SaasRepo, MetricRepo, AuditRepo, createRepos, type Database } from '@portfolio/db';
import { InProcessQueue } from './orchestrator/queue.ts';
import { DurableObjectGuard, SqlGuard, type GuardLike, type GuardNamespaceLike } from './do/guard.ts';
import {
  ApprovalRepo,
  BudgetRepo,
  EvaluationRepo,
  EventRepo,
  JobRepo,
  KillSwitchRepo,
  MemoryRepo,
  NotificationRepo,
  ReportRepo,
  RunRepo,
  SunsetRepo,
} from './orchestrator/store.ts';

export const EnvSchema = z.object({
  /** mode data deterministik: semua konektor mock, tidak ada panggilan keluar */
  MOCK_CONNECTORS: z.string().optional(),
  /** nama produk; dipakai pada halaman publik dan log */
  APP_NAME: z.string().default('Portfolio Holding'),
  /** dipakai untuk token layanan, tautan persetujuan, dan uji */
  JWT_SECRET: z.string().min(16).optional(),
  /** JWT Access: issuer, audience, dan JWKS */
  ACCESS_ISSUER: z.string().optional(),
  ACCESS_AUDIENCE: z.string().optional(),
  ACCESS_JWKS_URL: z.string().optional(),
  /** kunci Anthropic; kosong berarti agen memakai jawaban deterministik */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** mock kanal notifikasi saat lokal */
  NOTIFICATION_CHANNEL: z.enum(['log', 'http']).default('log'),
  CRON_ENABLED: z.string().optional(),
  /** lokasi SQLite lokal untuk runtime Node dan skrip (default: memori) */
  LOCAL_DB_PATH: z.string().optional(),
  /** TTL permintaan persetujuan dalam jam (FR-9.3) */
  APPROVAL_TTL_JAM: z.coerce.number().positive().optional(),
  PORT: z.coerce.number().int().positive().optional(),
});

type EnvVars = z.infer<typeof EnvSchema>;

export interface RepositoriSistem {
  /** koneksi mentah untuk kueri khas orkestrasi/ringkasan */
  db: Database;
  saas: SaasRepo;
  metric: MetricRepo;
  audit: AuditRepo;
  job: JobRepo;
  run: RunRepo;
  memory: MemoryRepo;
  budget: BudgetRepo;
  approval: ApprovalRepo;
  evaluasi: EvaluationRepo;
  sunset: SunsetRepo;
  event: EventRepo;
  kill: KillSwitchRepo;
  report: ReportRepo;
  notifikasi: NotificationRepo;
  queue: InProcessQueue;
}

export function buatRepositori(db: Database): RepositoriSistem {
  const base = createRepos(db);
  return {
    ...base,
    job: new JobRepo(db),
    run: new RunRepo(db),
    memory: new MemoryRepo(db),
    budget: new BudgetRepo(db),
    approval: new ApprovalRepo(db),
    evaluasi: new EvaluationRepo(db),
    sunset: new SunsetRepo(db),
    event: new EventRepo(db),
    kill: new KillSwitchRepo(db),
    report: new ReportRepo(db),
    notifikasi: new NotificationRepo(db),
    queue: new InProcessQueue(db),
  };
}

export interface Bindings extends EnvVars {
  DB: Database;
  /** repositori siap pakai; diisi `app.ts` dan orkestrator dari binding DB */
  repos?: RepositoriSistem;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  /**
   * Namespace Durable Object `SaasGuard`; absen pada runtime Node sehingga guard
   * berbasis tabel (`SqlGuard`) dipakai. Lihat `buatGuard`.
   */
  SAAS_GUARD?: GuardNamespaceLike;
  JOBS?: unknown;
  ANALYTICS?: { writeDataPoint?: (p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }) => void };
  ADMIN_DEV_TOKEN?: string;
}

export function readEnv(raw: Record<string, unknown>): Bindings {
  const parsed = EnvSchema.parse(raw);
  return { ...raw, ...parsed } as Bindings;
}

export function isMock(env: Bindings): boolean {
  return env.MOCK_CONNECTORS !== 'false';
}

/** Secret JWT wajib disediakan pada produksi; default khusus pengembangan. */
export function jwtSecret(env: Bindings): string {
  return env.JWT_SECRET ?? 'dev-only-secret-change-me-please';
}

/**
 * Pilih implementasi guard: satu Durable Object per SaaS bila binding tersedia
 * (Workers), selain itu tabel (`SqlGuard`, Node/test). Kill switch global tetap
 * dibaca dari tabel pada kedua jalur.
 */
export function buatGuard(env: Bindings, globalKill: () => Promise<boolean>): GuardLike {
  return env.SAAS_GUARD ? new DurableObjectGuard(env.SAAS_GUARD, globalKill) : new SqlGuard(env.DB, globalKill);
}
