/**
 * Konteks aplikasi (repositori + health engine + orkestrator) yang dibangun
 * dari binding. Dipisah di modul sendiri agar `app.ts` dan `index.ts` tidak
 * saling mengimpor (khususnya untuk bundle Workers).
 */
import type { Bindings } from './env.ts';
import { buatRepositori } from './env.ts';
import { HealthEngine } from './orchestrator/health.ts';
import { Orchestrator } from './orchestrator/cycle.ts';

export interface ApiContext {
  repos: ReturnType<typeof buatRepositori>;
  health: HealthEngine;
  orchestrator: Orchestrator;
}

export function apiContext(bindings: Bindings): ApiContext {
  const repos = bindings.repos ?? buatRepositori(bindings.DB);
  const now = () => Date.now();
  const ttlJam = bindings.APPROVAL_TTL_JAM;
  const health = new HealthEngine({ repos, now });
  const orchestrator = new Orchestrator({ db: bindings.DB, repos, env: bindings, now, ...(ttlJam ? { ttlMs: ttlJam * 3_600_000 } : {}) }, health);
  return { repos, health, orchestrator };
}
