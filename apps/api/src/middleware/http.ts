/**
 * Middleware HTTP: autentikasi, otorisasi peran, pembatasan laju, idempotensi,
 * dan logging terstruktur dengan run_id/saas_id (§5.7).
 */
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import { IDEM_KEY_HEADER, type Role, type Fungsi } from '@portfolio/shared';
import type { Bindings } from '../env.ts';
import { JwtError, verifyJwt, type Claims, type JsonWebKeySet } from '../auth.ts';
import { jwtSecret } from '../env.ts';

export interface AppVariables {
  claims: Claims | null;
  runId: string;
  requestId: string;
}

export type AppEnv = { Bindings: Bindings; Variables: AppVariables };

export class HttpError extends Error {
  readonly status: number;
  readonly kode: string;
  readonly detail: unknown;
  constructor(status: number, kode: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.kode = kode;
    this.detail = detail;
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new HttpError(500, 'internal_error', message);
}

/** Header permintaan trace untuk log terstruktur. */
export const requestContext: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && incoming.length <= 80 ? incoming : crypto.randomUUID();
  c.set('requestId', requestId);
  c.set('runId', c.req.header('x-run-id') ?? '');
  c.set('claims', null);
  c.header('x-request-id', requestId);
  const startedAt = Date.now();
  await next();
  const durasi = Date.now() - startedAt;
  const log = Promise.resolve().then(() =>
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'http.request',
        requestId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durasi,
        saas_id: c.req.param('id') ?? null,
        run_id: c.get('runId') || null,
      }),
    ),
  );
  // Workers menyediakan executionCtx; runtime Node/test tidak, jadi log tetap dicetak.
  try {
    if (c.executionCtx) c.executionCtx.waitUntil(log);
    else void log;
  } catch {
    void log;
  }
});

let jwksCache: { url: string; at: number; data: JsonWebKeySet } | null = null;

async function loadJwks(url: string, fetchImpl: typeof fetch = fetch): Promise<JsonWebKeySet> {
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 5 * 60_000) return jwksCache.data;
  const res = await fetchImpl(url);
  if (!res.ok) throw new HttpError(503, 'jwks_unavailable', `tidak dapat memuat JWKS (${res.status})`);
  const data = (await res.json()) as JsonWebKeySet;
  jwksCache = { url, at: Date.now(), data };
  return data;
}

/** Parse JWT dari header Authorization atau cookie Access. */
export async function authenticate(c: Context<AppEnv>): Promise<Claims | null> {
  const header = c.req.header('authorization');
  const cookie = c.req.header('cookie');
  let token: string | null = null;
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim();
  if (!token && cookie) {
    const match = /(?:^|;\s*)(?:CF_Authorization|access_token)=([^;]+)/.exec(cookie);
    if (match) token = decodeURIComponent(match[1]!);
  }
  // EventSource tidak dapat mengirim header; SSE memakai `?access_token=`.
  if (!token && new URL(c.req.url).pathname.endsWith('/events')) {
    token = c.req.query('access_token') ?? null;
  }
  if (!token) return null;
  const env = c.env;
  const jwks = env.ACCESS_JWKS_URL ? await loadJwks(env.ACCESS_JWKS_URL) : null;
  return verifyJwt(token, {
    secret: jwtSecret(env),
    ...(env.ACCESS_ISSUER ? { issuer: env.ACCESS_ISSUER } : {}),
    ...(env.ACCESS_AUDIENCE ? { audience: env.ACCESS_AUDIENCE } : {}),
    jwks,
  });
}

/** Autentikasi opsional: mengisi claims bila token valid, tidak menolak bila tidak ada token. */
export const optionalAuth: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const claims = await authenticate(c);
    if (claims) c.set('claims', claims);
  } catch (error) {
    if (error instanceof JwtError) {
      // token tidak valid diperlakukan seperti tidak login, kecuali route ber-peran
      c.set('claims', null);
    } else {
      throw error;
    }
  }
  await next();
});

export interface AuthOptions {
  roles: Role[];
  /** izinkan token konektor (scope saas+fungsi) */
  allowConnector?: boolean;
}

/** Penjaga peran: menolak bila tidak ada claims atau peran tidak diizinkan. */
export function requireRole(opts: AuthOptions): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    let claims = c.get('claims');
    if (!claims) {
      try {
        claims = await authenticate(c);
        if (claims) c.set('claims', claims);
      } catch (error) {
        if (error instanceof JwtError) throw new HttpError(401, 'unauthorized', `token tidak valid: ${error.alasan}`);
        if (error instanceof HttpError) throw error;
        throw error;
      }
    }
    if (!claims) throw new HttpError(401, 'unauthorized', 'autentikasi diperlukan');
    if (!opts.roles.includes(claims.role)) throw new HttpError(403, 'forbidden', `peran ${claims.role} tidak diizinkan`);
    // otorisasi per SaaS (§6.3): operator hanya melihat SaaS yang ditugaskan
    if (claims.role === 'operator') {
      const target = c.req.param('id') ?? c.req.param('saasId');
      if (target && claims.saas.length > 0 && !claims.saas.includes(target)) {
        throw new HttpError(403, 'forbidden_saas', 'operator tidak ditugaskan ke SaaS Unit ini');
      }
    }
    if (claims.role === 'service' || claims.role === 'connector') {
      const target = c.req.param('id');
      if (target && claims.saas.length > 0 && !claims.saas.includes(target)) {
        throw new HttpError(403, 'forbidden_saas', 'token layanan tidak berlaku untuk SaaS Unit ini');
      }
    }
    await next();
  });
}

/** True bila klaim boleh mengakses SaaS Unit tertentu. */
export function bolehAksesSaas(claims: Claims | null, saasId: string): boolean {
  if (!claims) return false;
  if (claims.role === 'service') return true;
  if (claims.role === 'owner') return true;
  return claims.saas.length === 0 || claims.saas.includes(saasId);
}

export function fungsiDariClaims(claims: Claims | null): Fungsi | null {
  return claims?.fungsi ?? null;
}

export function validasiSaasParam(c: Context<AppEnv>, claims: Claims | null): string {
  const id = c.req.param('id');
  if (!id) throw new HttpError(400, 'bad_request', 'id SaaS Unit wajib');
  if (!bolehAksesSaas(claims, id)) throw new HttpError(403, 'forbidden_saas', 'tidak diizinkan mengakses SaaS Unit ini');
  return id;
}

/** Idempotensi: header wajib untuk endpoint tulis; respons disimpan per kunci. */
export function idemKey(c: Context<AppEnv>): string {
  const key = c.req.header(IDEM_KEY_HEADER);
  if (!key || key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'idempotency_required', `header ${IDEM_KEY_HEADER} wajib (minimal 8 karakter)`);
  }
  return key;
}

/** Rate limit sederhana berbasis tabel (bisa diganti Durable Object/KV). */
export async function rateLimit(c: Context<AppEnv>, scope: string, limitPerMenit: number): Promise<void> {
  const key = `rl:${scope}:${c.get('claims')?.sub ?? c.req.header('cf-connecting-ip') ?? 'anon'}`;
  const now = Date.now();
  const row = await c.env.DB.prepare('SELECT createdAt, count FROM rate_limit WHERE key = ?').bind(key).first<{ createdAt: number; count: number }>();
  const windowStart = now - 60_000;
  if (!row || Number(row.createdAt) < windowStart) {
    await c.env.DB.prepare(
      'INSERT INTO rate_limit (key, createdAt, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET createdAt = excluded.createdAt, count = 1',
    )
      .bind(key, now)
      .run();
    return;
  }
  if (Number(row.count) >= limitPerMenit) throw new HttpError(429, 'rate_limited', 'terlalu banyak permintaan');
  await c.env.DB.prepare('UPDATE rate_limit SET count = count + 1 WHERE key = ?').bind(key).run();
}
