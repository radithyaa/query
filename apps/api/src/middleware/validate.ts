/**
 * Validasi masukan dengan Zod di tepi API: body JSON dan query string.
 * Kegagalan validasi dikembalikan sebagai 400 `validasi_gagal` berisi daftar
 * field, sehingga klien dapat memperbaiki permintaan tanpa menebak.
 */
import { z } from 'zod';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './http.ts';
import { HttpError } from './http.ts';

export async function zodBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'body_bukan_json', 'body permintaan harus berupa JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'validasi_gagal',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), pesan: i.message })),
    );
  }
  return parsed.data;
}

export function zodQuery<T extends z.ZodType>(schema: T): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'validasi_query_gagal',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '),
      );
    }
    c.set('queryData' as never, parsed.data as never);
    await next();
  });
}

/** Query yang sudah divalidasi `zodQuery` untuk rute saat ini. */
export function queryOf<T>(c: Context<AppEnv>): T {
  return c.get('queryData' as never) as T;
}

/** Validasi header `Idempotency-Key` tanpa membaca body (untuk endpoint tulis). */
export function requireIdemKey(): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header('Idempotency-Key');
    if (!key || key.length < 8 || key.length > 200) {
      throw new HttpError(400, 'idempotency_required', 'header Idempotency-Key wajib (minimal 8 karakter)');
    }
    await next();
  });
}
