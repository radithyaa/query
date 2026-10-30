/**
 * Token layanan berumur pendek untuk satu job (§7.2): hanya berlaku untuk
 * `saas_id` dan fungsi job itu, ditandatangani HS256 dengan secret Worker.
 */
import type { Claims } from '../auth.ts';
import { signHs256 } from '../auth.ts';

export async function signServiceToken(
  input: Omit<Claims, 'exp' | 'iat'>,
  opts: { secret: string; ttlDetik?: number; now?: number },
): Promise<string> {
  const nowDetik = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: Claims = { ...input, iat: nowDetik, exp: nowDetik + (opts.ttlDetik ?? 900) };
  return signHs256(claims, opts.secret);
}
