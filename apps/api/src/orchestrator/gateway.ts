/**
 * Policy gateway yang terhubung ke penyimpanan (§3.3 poin 5, §11.5).
 *
 * `decideGateway` tetap fungsi murni yang diuji sebagai tabel keputusan; modul ini
 * hanya menyiapkan konteks (kill switch, status SaaS, anggaran, rate limit),
 * membuat baris `approval` saat `perlu_persetujuan`, mencatat `audit_log`, dan
 * menerbitkan event `approval.requested`. Semua tool tulis lewat jalur ini.
 */
import {
  APPROVAL_LABELS,
  DEFAULT_APPROVAL_TTL_MS,
  type ApprovalJenis,
  type GatewayCheckRequest,
  type GatewayDecision,
  type Otonomi,
  type SaasStatus,
} from '@portfolio/shared';
import type { ApprovalRepo, EventRepo, KillSwitchRepo } from './store.ts';
import { decideGateway } from '../services/gateway-core.ts';

export interface GatewaySaasContext {
  status: SaasStatus;
  paused: boolean;
  otonomi: Partial<Record<string, Otonomi>>;
}

export interface GatewayDeps {
  approvals: ApprovalRepo;
  events: EventRepo;
  killswitch: KillSwitchRepo;
  /** actor audit untuk permintaan dari agen, mis. `agen:review` */
  loadSaas: (saasId: string) => Promise<GatewaySaasContext | null>;
  budget: (saasId: string, fungsi: string) => Promise<{ batas: number; terpakai: number }>;
  rate: (saasId: string, fungsi: string, limitPerMenit: number) => Promise<boolean>;
  now: () => number;
  newId: () => string;
  /** TTL persetujuan default (ms); dapat diubah lewat konfigurasi lingkungan */
  ttlMs?: number;
  /** batas tindakan tulis per menit per fungsi */
  rateLimitPerMenit?: number;
}

export interface GatewayResult extends GatewayDecision {
  jenis: ApprovalJenis | null;
  kedaluwarsa: number | null;
  /** true bila persetujuan baru dibuat oleh permintaan ini */
  approvalBaru: boolean;
}

function approvalPayload(req: GatewayCheckRequest): Record<string, unknown> {
  return {
    idemKey: req.idemKey,
    tindakan: req.tindakan,
    fungsi: req.fungsi,
    payload: req.payload,
    ringkasan: req.ringkasan_dampak ?? null,
    run_id: req.run_id ?? null,
    job_id: req.job_id ?? null,
    biaya_perkiraan_usd: req.biaya_perkiraan_usd ?? null,
  };
}

/** Buat (atau pakai ulang) baris approval untuk permintaan yang sama. */
export async function ciptakanApproval(
  deps: GatewayDeps,
  req: GatewayCheckRequest,
  opts: { jenis: ApprovalJenis; ringkasan: string; kedaluwarsa: number; jobId?: string | null },
): Promise<{ approvalId: string; baru: boolean }> {
  const existing = await deps.approvals.pendingForIdemKey(req.idemKey);
  if (existing) return { approvalId: existing.id, baru: false };

  const id = deps.newId();
  await deps.approvals.create({
    id,
    saasId: req.saasId,
    jobId: opts.jobId ?? req.job_id ?? null,
    jenis: opts.jenis,
    fungsi: req.fungsi,
    ringkasanDampak: opts.ringkasan,
    payload: approvalPayload(req),
    kedaluwarsa: opts.kedaluwarsa,
    dibuatPada: deps.now(),
  });
  await deps.events.emit(
    'approval.requested',
    {
      approval_id: id,
      jenis: opts.jenis,
      fungsi: req.fungsi,
      tindakan: req.tindakan,
      ringkasan: opts.ringkasan,
      kedaluwarsa: opts.kedaluwarsa,
    },
    { saasId: req.saasId, runId: req.run_id ?? null, now: deps.now() },
  );
  return { approvalId: id, baru: true };
}

/** Jalankan pemeriksaan gateway dan terapkan efek sampingnya. */
export async function evaluateGateway(deps: GatewayDeps, req: GatewayCheckRequest): Promise<GatewayResult> {
  const now = deps.now();
  const saas = await deps.loadSaas(req.saasId);
  const kill = await deps.killswitch.state();
  const budget = await deps.budget(req.saasId, req.fungsi);
  const rateOk = await deps.rate(req.saasId, req.fungsi, deps.rateLimitPerMenit ?? 60);
  const killSaas = kill.perSaas.get(req.saasId);
  const sisa = budget.batas > 0 ? Math.max(0, budget.batas - budget.terpakai) : null;
  const persen = budget.batas > 0 ? (budget.terpakai / budget.batas) * 100 : null;

  const outcome = decideGateway(req, {
    saas: {
      id: req.saasId,
      status: saas?.status ?? 'aktif',
      paused: saas?.paused ?? true,
      otonomi: saas?.otonomi ?? {},
      anggaranTerpakaiPersen: persen,
      sisaAnggaranUsd: sisa,
      batasAnggaranFungsiUsd: budget.batas > 0 ? budget.batas : null,
    },
    killGlobal: kill.global,
    killSaas: Boolean(killSaas?.aktif),
    killAlasan: kill.global ? kill.globalAlasan : (killSaas?.alasan ?? null),
    rateTerlampaui: !rateOk,
    now,
    ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
  });

  let approvalId: string | null = null;
  let approvalBaru = false;
  if (outcome.keputusan === 'perlu_persetujuan') {
    const jenis = (outcome.jenisPersetujuan ?? 'lainnya') as ApprovalJenis;
    const dibuat = await ciptakanApproval(deps, req, {
      jenis,
      ringkasan: req.ringkasan_dampak ?? `${APPROVAL_LABELS[jenis] ?? req.tindakan} oleh agen ${req.fungsi}`,
      kedaluwarsa: outcome.kedaluwarsa ?? now + (deps.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
    });
    approvalId = dibuat.approvalId;
    approvalBaru = dibuat.baru;
  }

  return {
    keputusan: outcome.keputusan,
    alasan: outcome.alasan,
    approval_id: approvalId,
    sisa_anggaran_usd: sisa,
    aturan: outcome.aturan,
    jenis: (outcome.jenisPersetujuan ?? null) as ApprovalJenis | null,
    kedaluwarsa: outcome.kedaluwarsa ?? null,
    approvalBaru,
  };
}
