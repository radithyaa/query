/**
 * JWT (HS256 untuk token layanan; RS256/EdDSA via JWKS untuk Cloudflare Access)
 * memakai WebCrypto sehingga jalan di Workers dan Node (§7.2).
 */
import type { Fungsi, Role } from '@portfolio/shared';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array<ArrayBufferLike> | string): string {
  const raw = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Claims {
  sub: string;
  role: Role;
  /** SaaS yang boleh diakses; kosong = semua */
  saas: string[];
  fungsi?: Fungsi;
  job_id?: string;
  iss?: string;
  aud?: string | string[];
  exp: number;
  iat?: number;
  email?: string;
  mfa?: boolean;
}

export type SigAlg = 'HS256' | 'RS256' | 'ES256';

function jsonPart(value: unknown): string {
  return b64url(enc.encode(JSON.stringify(value)) as unknown as Uint8Array);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signHs256(claims: Claims, secret: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) as unknown as Uint8Array);
  const payload = b64url(enc.encode(JSON.stringify(claims)) as unknown as Uint8Array);
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

export interface VerifyOptions {
  secret?: string;
  issuer?: string;
  audience?: string;
  /** JWKS pemverifikasi untuk Access; hasilnya di-cache oleh pemanggil */
  jwks?: JsonWebKeySet | null;
  now?: number;
  /** toleransi jam (detik) */
  leeway?: number;
}

export interface JsonWebKeySet {
  keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

export class JwtError extends Error {
  readonly alasan: string;
  constructor(alasan: string) {
    super(alasan);
    this.name = 'JwtError';
    this.alasan = alasan;
  }
}

function challengeOf(alg: string): 'HS256' | 'RS256' | 'ES256' {
  if (alg === 'HS256') return 'HS256';
  if (alg === 'ES256') return 'ES256';
  return 'RS256';
}

export async function verifyJwt(token: string, opts: VerifyOptions): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('format token tidak valid');
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = JSON.parse(dec.decode(fromB64url(headerPart)));
    claims = JSON.parse(dec.decode(fromB64url(payloadPart)));
  } catch {
    throw new JwtError('header atau payload tidak dapat dibaca');
  }
  const data = enc.encode(`${headerPart}.${payloadPart}`);
  const signature = fromB64url(sigPart);

  if (header.alg === 'HS256') {
    if (!opts.secret) throw new JwtError('secret tidak dikonfigurasi');
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(opts.secret), signature, data);
    if (!ok) throw new JwtError('tanda tangan tidak valid');
  } else if (header.alg === 'RS256' || header.alg === 'ES256') {
    const jwks = opts.jwks;
    if (!jwks) throw new JwtError('JWKS tidak tersedia');
    const jwk = jwks.keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
    if (!jwk) throw new JwtError('kunci publik untuk token tidak ditemukan');
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      header.alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      header.alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      data,
    );
    if (!ok) throw new JwtError('tanda tangan tidak valid');
  } else {
    throw new JwtError(`algoritma tidak didukung: ${String(header.alg)}`);
  }
  void challengeOf;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = opts.leeway ?? 30;
  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) throw new JwtError('token kedaluwarsa');
  if (opts.issuer && claims.iss && claims.iss !== opts.issuer) throw new JwtError('issuer tidak cocok');
  if (opts.audience) {
    const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!auds.includes(opts.audience)) throw new JwtError('audience tidak cocok');
  }
  if (!claims.sub) throw new JwtError('sub tidak ada');
  if (!claims.role) throw new JwtError('role tidak ada');
  if (!Array.isArray(claims.saas)) claims.saas = [];
  return claims;
}

/** Tautan persetujuan bertanda tangan (HMAC) dan kedaluwarsa (§7.1). */
export async function signApprovalLink(input: { approvalId: string; saasId: string; exp: number; secret: string }): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ a: input.approvalId, s: input.saasId, e: input.exp })) as unknown as Uint8Array);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(input.secret), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyApprovalLink(token: string, secret: string, now = Date.now()): Promise<{ approvalId: string; saasId: string } | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(body))) as { a: string; s: string; e: number };
    if (data.e < now) return null;
    return { approvalId: data.a, saasId: data.s };
  } catch {
    return null;
  }
}

/** Tanda tangan webhook (GitHub `X-Hub-Signature-256`). */
export async function verifyWebhook(secret: string, payload: string, signature: string | undefined): Promise<boolean> {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  const hex = [...new Uint8Array(expected)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = signature.slice('sha256='.length);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i += 1) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
