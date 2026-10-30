/**
 * Utilitas kecil tanpa dependensi yang dipakai di Worker maupun Node.
 * SHA-256 lewat WebCrypto (`crypto.subtle`), tersedia di Workers dan Node 20+.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(digest);
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function nowMs(): number {
  return Date.now();
}

/** Tanggal UTC dalam bentuk YYYY-MM-DD. */
export function isoDate(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Tanggal lokal Asia/Jakarta (WIB, UTC+7) untuk penjadwalan laporan harian. */
export function jakartaDate(ts: number = Date.now()): string {
  return new Date(ts + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function periodeBulan(ts: number = Date.now()): string {
  return isoDate(ts).slice(0, 7);
}

/** Nomor minggu ISO (untuk kunci idempotensi job mingguan). */
export function isoWeek(ts: number = Date.now()): string {
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Gabungkan default dengan override yang hanya berisi nilai terdefinisi. */
export function mergeDefined<T extends object>(base: T, override?: Partial<T> | null): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out as T;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function safeJsonParse<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Potong string pada batas kata untuk log/ringkasan. */
export function truncate(text: string, max = 280): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<!\d)(?:\+?62|0)8\d{7,11}(?!\d)/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Redaksi PII sebelum disimpan atau dikirim ke model (NFR-12, §6.3). */
export function redactPii(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, '[telepon]')
    .replace(CARD_RE, '[kartu]');
}

export interface EnvLike {
  [key: string]: string | undefined;
}

export function intEnv(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
