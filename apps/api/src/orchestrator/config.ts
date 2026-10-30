/**
 * Konfigurasi satu SaaS Unit yang sudah dinormalisasi (padanan §11.1).
 * Disimpan di `saas_unit.config` sebagai JSON dan divalidasi skema Zod.
 */
import { SaasConfig, type SaasConfigResolved } from '@portfolio/shared';
import type { SaasRecord } from '@portfolio/db';

export function resolveConfig(saas: Pick<SaasRecord, 'config'>): SaasConfigResolved {
  return SaasConfig.parse(saas.config ?? {});
}

export type { SaasConfigResolved };
