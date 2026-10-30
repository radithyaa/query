/**
 * Klien API `/api/v1` (SRS §7.2) untuk dashboard.
 *
 * - Token Bearer disimpan di `sessionStorage` (bukan `localStorage`) agar tidak
 *   tertinggal di perangkat bersama; SSE memakai `?access_token=` karena
 *   EventSource tidak dapat mengirim header (lihat `authenticate()` di server).
 * - Endpoint tulis selalu mengirim `Idempotency-Key` (NFR-7).
 * - Galat server `{ error: { kode, pesan, detail }, requestId }` dipetakan ke
 *   `ApiError` agar UI dapat membedakan "belum login", "khusus pemilik", dsb.
 */
import type { Fungsi } from '@portfolio/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly kode: string;
  readonly detail: unknown;
  readonly requestId: string | null;

  constructor(status: number, kode: string, pesan: string, detail: unknown = null, requestId: string | null = null) {
    super(pesan);
    this.name = 'ApiError';
    this.status = status;
    this.kode = kode;
    this.detail = detail;
    this.requestId = requestId;
  }

  get belumLogin(): boolean {
    return this.status === 401;
  }

  get khususPemilik(): boolean {
    return this.kode === 'khusus_pemilik' || this.kode === 'forbidden';
  }

  get mfaDiperlukan(): boolean {
    return this.kode === 'mfa_diperlukan';
  }
}

// ------------------------------------------------------------------ token

const TOKEN_KEY = 'portfolio.token';

export function bacaToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function simpanToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // mode privat tanpa storage: token tetap hidup di memori selama sesi halaman
  }
}

/** Klaim yang relevan untuk UI; server tetap sumber kebenaran otorisasi. */
export interface Sesi {
  sub: string;
  role: string;
  email: string | null;
  saas: string[];
  mfa: boolean;
  exp: number;
}

/** Baca payload JWT tanpa verifikasi — hanya untuk menyesuaikan tampilan. */
export function sesiDariToken(token: string): Sesi | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
        .split('')
        .map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const claims = JSON.parse(json) as Partial<Sesi>;
    return {
      sub: String(claims.sub ?? ''),
      role: String(claims.role ?? ''),
      email: claims.email ?? null,
      saas: Array.isArray(claims.saas) ? claims.saas : [],
      mfa: claims.mfa === true,
      exp: Number(claims.exp ?? 0),
    };
  } catch {
    return null;
  }
}

/** Pemilik atau operator — peran yang boleh memakai dashboard (NFR-5). */
export function sesiDashboard(token: string): Sesi | null {
  const sesi = sesiDariToken(token);
  if (!sesi) return null;
  if (sesi.exp > 0 && sesi.exp * 1000 <= Date.now()) return null;
  return sesi.role === 'owner' || sesi.role === 'operator' ? sesi : null;
}

// ------------------------------------------------------------------ fetch

/** Kunci idempoten unik per tindakan UI (NFR-7). */
export function idemKey(prefix: string): string {
  const acak = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${acak}`.slice(0, 200);
}

export interface PanggilanOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
  /** kunci idempoten eksplisit (default dibuat baru) */
  idem?: string;
}

async function ambil(path: string, opts: PanggilanOptions = {}): Promise<unknown> {
  const token = bacaToken();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const method = opts.method ?? 'GET';
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = opts.idem ?? idemKey(`ui-${method.toLowerCase()}`);

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      credentials: 'same-origin',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'jaringan', 'Tidak dapat menghubungi server API.');
  }

  const teks = await res.text();
  let data: unknown = null;
  if (teks) {
    try {
      data = JSON.parse(teks) as unknown;
    } catch {
      data = { raw: teks };
    }
  }

  if (!res.ok) {
    const galat = (data as { error?: { kode?: string; pesan?: string; detail?: unknown }; requestId?: string } | null) ?? null;
    throw new ApiError(
      res.status,
      galat?.error?.kode ?? `http_${res.status}`,
      galat?.error?.pesan ?? `Permintaan gagal (HTTP ${res.status})`,
      galat?.error?.detail ?? null,
      galat?.requestId ?? null,
    );
  }
  return data;
}

export function panggil<T>(path: string, opts: PanggilanOptions = {}): Promise<T> {
  return ambil(`/api/v1${path}`, opts) as Promise<T>;
}

// ------------------------------------------------------------------ tipe kontrak

export type Peringkat = 'sehat' | 'pengawasan' | 'kritis' | 'tidak_diketahui';

export interface PortfolioRow {
  id: string;
  slug: string;
  nama: string;
  status: string;
  status_label: string;
  paused: boolean;
  skor: number | null;
  data_cukup: boolean;
  komponen_lemah: Array<{ key: string; label: string; score: number }>;
  mrr: number | null;
  mrr_tren_persen: number | null;
  signup: number | null;
  rating: number | null;
  biaya_agen_usd: number;
  persetujuan_menunggu: number;
  peringkat: Peringkat;
}

export interface PortfolioSummary {
  tanggal: string;
  periode_hari: number;
  total: number;
  sehat: number;
  perlu_perhatian: number;
  skor_rata2: number | null;
  biaya_agen_30hari_usd: number;
  persetujuan_menunggu: number;
  units: PortfolioRow[];
}

export interface SaasRingkas {
  id: string;
  slug: string;
  nama: string;
  status: string;
  status_label: string;
  status_sejak: number;
  paused: boolean;
  repo: string | null;
  akun_toko: string | null;
  akun_sosial: string | null;
}

export interface KonektorRingkas {
  jenis: string;
  secret_ref: string;
  utama: boolean;
  terakhir_sehat: number | null;
}

export interface SaasDetail extends SaasRingkas {
  config: Record<string, unknown>;
  konektor: KonektorRingkas[];
}

export interface KomponenSkor {
  key: string;
  score?: number | null;
  bobot?: number;
  terpakai?: boolean;
  nilai?: number | null;
}

export interface EvaluasiRingkas {
  tanggal: string;
  skor: number;
  data_cukup: boolean;
  status_lama: string;
  status_baru: string;
  alasan: string;
}

export interface SunsetRingkas {
  id: string;
  tahap: string;
  keputusan: string | null;
  dibuat_pada: number;
}

export interface StatusSaas {
  id: string;
  nama: string;
  status: string;
  status_label: string;
  status_sejak: number;
  paused: boolean;
  skor: number | null;
  data_cukup: boolean;
  komponen: KomponenSkor[];
  alasan: string | null;
  evaluasi: EvaluasiRingkas[];
  sunset: SunsetRingkas | null;
}

export interface MetrikHarian {
  tanggal: string;
  metrik: Record<string, unknown> | null;
  diterima_pada: number;
}

export interface ApprovalPayload {
  idemKey?: string;
  tindakan?: string;
  payload?: Record<string, unknown>;
  run_id?: string;
  [key: string]: unknown;
}

export type ApprovalStatus = 'menunggu' | 'disetujui' | 'ditolak' | 'revisi' | 'kedaluwarsa';

export interface Approval {
  id: string;
  saasId: string;
  jobId: string | null;
  jenis: string;
  fungsi: Fungsi | null;
  ringkasanDampak: string;
  payload: ApprovalPayload;
  status: ApprovalStatus;
  kedaluwarsa: number;
  dibuatPada: number;
  diputuskanOleh: string | null;
  diputuskanPada: number | null;
  catatan: string | null;
}

export interface SunsetCase {
  id: string;
  saasId: string;
  paketBukti: Record<string, unknown>;
  tahap: string;
  keputusan: string | null;
  diputuskanOleh: string | null;
  diputuskanPada: number | null;
  dibuatPada: number;
  tenggatBaru: string | null;
  catatan: string | null;
}

export interface AuditItem {
  id: number;
  waktu: number;
  aktor: string;
  saas_id: string | null;
  tindakan: string;
  masukan: unknown;
  keluaran: unknown;
  hash: string;
  hash_sebelumnya: string | null;
}

export interface AuditFilterEcho {
  saas_id?: string;
  aktor?: string;
  tindakan?: string;
  dari?: string;
  sampai?: string;
  limit: number;
  offset: number;
  dari_ms: number | null;
  sampai_ms: number | null;
}

export interface VerifikasiAudit {
  valid: boolean;
  checked: number;
  rusakPada: number | null;
}

export interface KillState {
  global: boolean;
  global_alasan: string | null;
  per_saas: Array<{ saas_id: string; aktif: boolean; alasan: string | null }>;
  riwayat: Array<Record<string, unknown>>;
}

export interface Laporan {
  id: string;
  periode: string;
  saasId: string | null;
  isi: Record<string, unknown> | null;
  dibuatPada: number;
}

export interface OpsMetrik {
  antrean: number;
  dead_letter: number;
  persetujuan_menunggu: number;
  job_selesai_7hari: number;
  job_dead_7hari: number;
  biaya_agen_30hari_usd: number;
}

export interface RingkasanSistem {
  ok: boolean;
  db: boolean;
  audit_chain: VerifikasiAudit | null;
}

// ------------------------------------------------------------------ endpoint

export const api = {
  summary: (periode: number, signal?: AbortSignal) =>
    panggil<{ data: PortfolioSummary }>(`/portfolio/summary?periode=${periode}`, { signal }),

  units: (signal?: AbortSignal) => panggil<{ data: SaasRingkas[]; total: number }>('/saas?limit=500', { signal }),

  unit: (id: string, signal?: AbortSignal) => panggil<{ data: SaasDetail }>(`/saas/${encodeURIComponent(id)}`, { signal }),

  status: (id: string, signal?: AbortSignal) =>
    panggil<{ data: StatusSaas }>(`/saas/${encodeURIComponent(id)}/status`, { signal }),

  metrik: (id: string, periode: number, signal?: AbortSignal) =>
    panggil<{ data: MetrikHarian[] }>(`/saas/${encodeURIComponent(id)}/metrics?periode=${periode}`, { signal }),

  ubahConfig: (id: string, config: Record<string, unknown>, signal?: AbortSignal) =>
    panggil<{ data: Record<string, unknown> }>(`/saas/${encodeURIComponent(id)}/config`, {
      method: 'PATCH',
      body: { config },
      signal,
    }),

  jeda: (id: string, paused: boolean) =>
    panggil<{ data: { id: string; paused: boolean } }>(
      `/saas/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`,
      { method: 'POST' },
    ),

  approvals: (params: { status?: string; saas_id?: string; limit?: number; signal?: AbortSignal } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.saas_id) q.set('saas_id', params.saas_id);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return panggil<{ data: Approval[]; total: number }>(`/approvals${qs ? `?${qs}` : ''}`, { signal: params.signal });
  },

  putuskanApproval: (id: string, keputusan: 'setujui' | 'tolak' | 'revisi', catatan?: string, signal?: AbortSignal) =>
    panggil<{ data: { id: string; status: string; efek: Record<string, unknown> | null } }>(
      `/approvals/${encodeURIComponent(id)}/decision`,
      {
        method: 'POST',
        body: { keputusan, ...(catatan?.trim() ? { catatan: catatan.trim() } : {}) },
        signal,
      },
    ),

  sunsetList: (signal?: AbortSignal) => panggil<{ data: SunsetCase[] }>('/sunset', { signal }),

  putuskanSunset: (
    id: string,
    body: { keputusan: 'setujui' | 'tolak' | 'pengecualian'; mfa_token: string; catatan?: string; tenggat_baru?: string },
    signal?: AbortSignal,
  ) =>
    panggil<{ data: { ok: boolean; tahap?: string; status?: string } }>(`/sunset/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body,
      signal,
    }),

  majukanSunset: (id: string, signal?: AbortSignal) =>
    panggil<{ data: { ok: boolean; tahap?: string } }>(`/sunset/${encodeURIComponent(id)}/advance`, {
      method: 'POST',
      signal,
    }),

  killswitch: (signal?: AbortSignal) => panggil<{ data: KillState }>('/killswitch', { signal }),

  setKillswitch: (body: { aktif: boolean; saas_id?: string; alasan: string }, signal?: AbortSignal) =>
    panggil<{ data: { cakupan: string; saas_id: string | null; aktif: boolean } }>('/killswitch', {
      method: 'POST',
      body,
      signal,
    }),

  audit: (
    params: {
      limit?: number;
      offset?: number;
      aktor?: string;
      tindakan?: string;
      dari?: string;
      sampai?: string;
      /** FR-7.5/7.6: dilayani klien karena `AuditQuery` server belum memuat `saas_id` */
      saas_id?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    const q = new URLSearchParams();
    q.set('limit', String(params.limit ?? 100));
    q.set('offset', String(params.offset ?? 0));
    if (params.aktor) q.set('aktor', params.aktor);
    if (params.tindakan) q.set('tindakan', params.tindakan);
    if (params.dari) q.set('dari', params.dari);
    if (params.sampai) q.set('sampai', params.sampai);
    return panggil<{ data: AuditItem[]; filter: AuditFilterEcho }>(`/audit?${q.toString()}`, { signal: params.signal });
  },

  verifyAudit: (signal?: AbortSignal) => panggil<{ data: VerifikasiAudit }>('/audit/verify', { signal }),

  laporanTerbaru: (signal?: AbortSignal) => panggil<{ data: Laporan | null }>('/reports/latest', { signal }),

  laporan: (limit = 20, signal?: AbortSignal) => panggil<{ data: Laporan[] }>(`/reports?limit=${limit}`, { signal }),

  ops: (signal?: AbortSignal) => panggil<{ data: OpsMetrik }>('/ops/metrics', { signal }),

  /** Endpoint lokal saja (`scripts/node-server.ts`); 404 di produksi. */
  loginDev: (role: 'owner' | 'operator', signal?: AbortSignal) =>
    panggil<{ data: { token: string; role: string; ttl_detik: number } }>('/login', {
      method: 'POST',
      body: { role },
      signal,
    }),
};

/** `/healthz` berada di luar `/api/v1`, jadi tidak lewat `panggil`. */
export async function healthz(signal?: AbortSignal): Promise<RingkasanSistem> {
  const res = await fetch('/healthz', { headers: { accept: 'application/json' }, credentials: 'same-origin', signal });
  if (!res.ok && res.status !== 503) throw new ApiError(res.status, 'healthz', 'Server tidak merespons.');
  return (await res.json()) as RingkasanSistem;
}
