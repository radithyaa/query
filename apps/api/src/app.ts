/**
 * Aplikasi Hono (§7.2): API inti `/api/v1`, policy gateway, alur persetujuan,
 * publikasi dashboard, dan SSE. Modul ini tidak mengimpor apa pun dari
 * Cloudflare sehingga dapat dijalankan di Workers maupun Node.
 *
 * Keputusan kepemilikan (siapa bertindak) ditegakkan oleh middleware
 * `requireRole` + pemeriksaan SaaS per klaim (§6.3), bukan oleh klien.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ApprovalDecisionRequest,
  ApprovalsQuery,
  AuditQuery,
  CreateSaasRequest,
  GatewayCheckRequest,
  IngestRequest,
  KillSwitchRequest,
  ListQuery,
  SERVICE_TOKEN_TTL_MAKS_DETIK,
  STATUS_LABELS,
  SaasConfig,
  SunsetDecisionRequest,
  isoDate,
  randomId,
  truncate,
  type ApprovalJenis,
  type Fungsi,
} from '@portfolio/shared';
import { zodBody, zodQuery, queryOf } from './middleware/validate.ts';
import { HttpError, bolehAksesSaas, idemKey, optionalAuth, rateLimit, requestContext, requireRole, type AppEnv } from './middleware/http.ts';
import { signServiceToken } from './services/tokens.ts';
import { apiContext, type ApiContext } from './context.ts';
import { recentAudit, verifyAuditChain } from './services/audit.ts';
import { evaluateGateway } from './orchestrator/gateway.ts';
import { resolveConfig } from './orchestrator/config.ts';
import { portfolioSummary } from './services/summary.ts';
import { publishAssets, serveSpa } from './services/assets.ts';

// ------------------------------------------------------------------ tipe

export { apiContext, type ApiContext };

function ctxOf(c: Context<AppEnv>): ApiContext {
  const cached = c.get('ctx' as never) as ApiContext | undefined;
  if (cached) return cached;
  const built = apiContext(c.env);
  c.set('ctx' as never, built as never);
  return built;
}

function claimsOf(c: Context<AppEnv>) {
  return c.get('claims');
}

/** Aktor untuk log audit dan kolom keputusan. */
export function aktorOf(c: Context<AppEnv>): string {
  const claims = claimsOf(c);
  if (!claims) return 'sistem';
  const email = claims.email ?? claims.sub;
  return `${claims.role}:${email}`;
}

async function loadSaas(c: Context<AppEnv>, id: string) {
  const { repos } = ctxOf(c);
  const saas = await repos.saas.byId(id);
  if (!saas) throw new HttpError(404, 'not_found', 'SaaS Unit tidak ditemukan');
  if (!bolehAksesSaas(claimsOf(c), saas.id)) throw new HttpError(403, 'forbidden_saas', 'tidak diizinkan mengakses SaaS Unit ini');
  return saas;
}

// ------------------------------------------------------------------ rute

export function buildApp() {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext);
  app.use('*', optionalAuth);

  app.onError((error, c) => {
    const status = error instanceof HttpError ? error.status : 500;
    const kode = error instanceof HttpError ? error.kode : 'internal_error';
    const pesan = error instanceof HttpError ? error.message : 'Terjadi kesalahan internal';
    if (status >= 500) {
      console.error(JSON.stringify({ level: 'error', msg: 'http.error', requestId: c.get('requestId'), kode, pesan: error instanceof Error ? error.message : String(error) }));
    }
    return c.json({ error: { kode, pesan, detail: error instanceof HttpError ? (error.detail ?? null) : null }, requestId: c.get('requestId') ?? null }, status as 400);
  });

  // ---------------------------------------------------------------- kesehatan

  app.get('/healthz', async (c) => {
    const { repos } = ctxOf(c);
    let db = false;
    try {
      await repos.db.prepare('SELECT 1 AS ok').first();
      db = true;
    } catch {
      db = false;
    }
    const chain = db ? await verifyAuditChain(c).catch(() => null) : null;
    return c.json({ ok: db, db, audit_chain: chain, sekarang: new Date().toISOString() }, db ? 200 : 503);
  });

  // ---------------------------------------------------------------- SaaS Unit

  const owner = requireRole({ roles: ['owner'] });
  const ownerOperator = requireRole({ roles: ['owner', 'operator'] });
  const anyRole = requireRole({ roles: ['owner', 'operator', 'service', 'connector'] });

  app.get('/api/v1/saas', ownerOperator, zodQuery(ListQuery), async (c) => {
    const q = queryOf<z.infer<typeof ListQuery>>(c);
    const { repos } = ctxOf(c);
    const units = await repos.saas.all({ ...(q.status ? { status: q.status } : {}), limit: q.limit, offset: q.offset });
    const claims = claimsOf(c);
    const terlihat = claims?.role === 'operator' && claims.saas.length > 0 ? units.filter((u) => claims.saas.includes(u.id)) : units;
    return c.json({
      data: terlihat.map((u) => ({
        id: u.id,
        slug: u.slug,
        nama: u.nama,
        status: u.status,
        status_label: STATUS_LABELS[u.status],
        status_sejak: u.statusSejak,
        paused: u.paused,
        repo: u.repo,
        akun_toko: u.akunToko,
        akun_sosial: u.akunSosial,
      })),
      total: terlihat.length,
    });
  });

  app.post('/api/v1/saas', owner, async (c) => {
    const key = idemKey(c);
    const body = await zodBody(c, CreateSaasRequest);
    const { repos } = ctxOf(c);
    const ada = await repos.saas.bySlug(body.slug);
    if (ada) throw new HttpError(409, 'slug_dipakai', `slug ${body.slug} sudah dipakai`);
    const config = SaasConfig.parse(body.config ?? {});
    const id = randomId();
    const now = Date.now();
    await repos.saas.insert({
      id,
      slug: body.slug,
      nama: body.nama,
      status: body.status,
      config: { ...config, ...(body.platform.length > 0 ? { platform: body.platform } : {}) },
      dibuatPada: now,
      repo: body.repo ?? null,
      akunToko: body.akun_toko ?? null,
      akunSosial: body.akun_sosial ?? null,
    });
    for (const k of body.konektor) {
      await repos.saas.upsertConnector({ id: randomId(), saasId: id, jenis: k.jenis, secretRef: k.secret_ref, detail: k.detail, utama: k.utama });
    }
    await repos.audit.append({ aktor: aktorOf(c), tindakan: 'saas.dibuat', saasId: id, masukan: { slug: body.slug, idem_key: key }, keluaran: { id, status: body.status }, waktu: now });
    return c.json({ data: { id, slug: body.slug, nama: body.nama, status: body.status } }, 201);
  });

  app.get('/api/v1/saas/:id', ownerOperator, async (c) => {
    const saas = await loadSaas(c, c.req.param('id'));
    const { repos } = ctxOf(c);
    const connectors = await repos.saas.connectors(saas.id);
    return c.json({
      data: {
        ...saas,
        config: resolveConfig(saas),
        konektor: connectors.map((k) => ({ jenis: k.jenis, secret_ref: k.secretRef, utama: k.utama, terakhir_sehat: k.terakhirSehat })),
      },
    });
  });

  app.patch('/api/v1/saas/:id/config', owner, async (c) => {
    idemKey(c);
    const saas = await loadSaas(c, c.req.param('id'));
    const body = await zodBody(c, z.object({ config: SaasConfig.partial() }));
    const { repos } = ctxOf(c);
    const config = SaasConfig.parse({ ...(saas.config as Record<string, unknown>), ...body.config });
    await repos.saas.updateConfig(saas.id, config);
    await repos.audit.append({ aktor: aktorOf(c), tindakan: 'saas.config', saasId: saas.id, masukan: body.config, keluaran: { config }, waktu: Date.now() });
    return c.json({ data: config });
  });

  app.post('/api/v1/saas/:id/metrics', requireRole({ roles: ['connector', 'owner'] }), async (c) => {
    const saas = await loadSaas(c, c.req.param('id'));
    const metric = await zodBody(c, IngestRequest);
    const { repos } = ctxOf(c);
    const now = Date.now();
    await repos.metric.upsert({ saas_id: saas.id, tanggal: metric.tanggal, skema_versi: metric.skema_versi, metrik: metric, diterima_pada: now });
    await repos.event.emit('metric.ingested', { tanggal: metric.tanggal, sumber: { konektor: true } }, { saasId: saas.id, now });
    const keterlambatanMenit = Math.round((now - Date.parse(`${metric.tanggal}T00:00:00Z`)) / 60_000);
    return c.json({ data: { diterima: true, tanggal: metric.tanggal, keterlambatan_menit: keterlambatanMenit } }, 202);
  });

  app.get('/api/v1/saas/:id/metrics', ownerOperator, zodQuery(ListQuery), async (c) => {
    const saas = await loadSaas(c, c.req.param('id'));
    const q = queryOf<z.infer<typeof ListQuery>>(c);
    const { repos } = ctxOf(c);
    const rows = await repos.metric.list(saas.id, q.periode);
    return c.json({ data: rows.map((r) => ({ tanggal: r.tanggal, metrik: r.metrik, diterima_pada: r.diterima_pada })) });
  });

  app.get('/api/v1/saas/:id/status', ownerOperator, async (c) => {
    const saas = await loadSaas(c, c.req.param('id'));
    const { repos } = ctxOf(c);
    const [history, sunset] = await Promise.all([repos.evaluasi.history(saas.id, 30), repos.sunset.latestForSaas(saas.id)]);
    const terbaru = history[0] ?? null;
    return c.json({
      data: {
        id: saas.id,
        nama: saas.nama,
        status: saas.status,
        status_label: STATUS_LABELS[saas.status],
        status_sejak: saas.statusSejak,
        paused: saas.paused,
        skor: terbaru?.skor ?? null,
        data_cukup: terbaru?.dataCukup ?? false,
        komponen: terbaru?.komponen ?? [],
        alasan: terbaru?.alasan ?? null,
        evaluasi: history.map((h) => ({ tanggal: h.tanggal, skor: h.skor, data_cukup: h.dataCukup, status_lama: h.statusLama, status_baru: h.statusBaru, alasan: h.alasan })),
        sunset: sunset ? { id: sunset.id, tahap: sunset.tahap, keputusan: sunset.keputusan, dibuat_pada: sunset.dibuatPada } : null,
      },
    });
  });

  for (const aksi of ['pause', 'resume'] as const) {
    app.post(`/api/v1/saas/:id/${aksi}`, owner, async (c) => {
      const saas = await loadSaas(c, c.req.param('id'));
      idemKey(c);
      const { repos } = ctxOf(c);
      const paused = aksi === 'pause';
      await repos.saas.setPaused(saas.id, paused);
      if (paused) await repos.kill.set('saas', true, `jeda manual oleh pemilik`, aktorOf(c), { saasId: saas.id });
      else await repos.kill.set('saas', false, 'jeda dicabut pemilik', aktorOf(c), { saasId: saas.id });
      await repos.audit.append({ aktor: aktorOf(c), tindakan: `saas.${aksi}`, saasId: saas.id, waktu: Date.now() });
      return c.json({ data: { id: saas.id, paused } });
    });
  }

  // ---------------------------------------------------------------- portofolio

  app.get('/api/v1/portfolio/summary', ownerOperator, zodQuery(ListQuery), async (c) => {
    const q = queryOf<z.infer<typeof ListQuery>>(c);
    const { repos } = ctxOf(c);
    const claims = claimsOf(c);
    const summary = await portfolioSummary(repos, { periode: q.periode, now: Date.now(), hanya: claims?.role === 'operator' && claims.saas.length > 0 ? claims.saas : null });
    return c.json({ data: summary });
  });

  app.get('/api/v1/reports', ownerOperator, zodQuery(ListQuery), async (c) => {
    const { repos } = ctxOf(c);
    return c.json({ data: await repos.report.list(queryOf<z.infer<typeof ListQuery>>(c).limit) });
  });

  app.get('/api/v1/reports/latest', ownerOperator, async (c) => {
    const { repos } = ctxOf(c);
    const laporan = await repos.report.latest(isoDate());
    if (!laporan) return c.json({ data: null }, 404);
    return c.json({ data: laporan });
  });

  // ---------------------------------------------------------------- persetujuan

  app.get('/api/v1/approvals', ownerOperator, zodQuery(ApprovalsQuery), async (c) => {
    const q = queryOf<z.infer<typeof ApprovalsQuery>>(c);
    const { repos } = ctxOf(c);
    const claims = claimsOf(c);
    const daftar = await repos.approval.list({ status: q.status, ...(q.saas_id ? { saasId: q.saas_id } : {}), limit: q.limit });
    const terlihat = claims?.role === 'operator' && claims.saas.length > 0 ? daftar.filter((a) => claims.saas.includes(a.saasId)) : daftar;
    return c.json({ data: terlihat, total: terlihat.length });
  });

  app.get('/api/v1/approvals/:id', ownerOperator, async (c) => {
    const { repos } = ctxOf(c);
    const approval = await repos.approval.byId(c.req.param('id'));
    if (!approval) throw new HttpError(404, 'not_found', 'Persetujuan tidak ditemukan');
    if (!bolehAksesSaas(claimsOf(c), approval.saasId)) throw new HttpError(403, 'forbidden_saas', 'tidak diizinkan');
    return c.json({ data: approval });
  });

  app.post('/api/v1/approvals/:id/decision', requireRole({ roles: ['owner', 'operator'] }), async (c) => {
    idemKey(c);
    const body = await zodBody(c, ApprovalDecisionRequest);
    const id = c.req.param('id');
    const { repos, orchestrator } = ctxOf(c);
    const approval = await repos.approval.byId(id);
    if (!approval) throw new HttpError(404, 'not_found', 'Persetujuan tidak ditemukan');
    if (!bolehAksesSaas(claimsOf(c), approval.saasId)) throw new HttpError(403, 'forbidden_saas', 'tidak diizinkan');
    // operator hanya boleh memutuskan kategori yang aman; sunset & PR selalu pemilik
    const hanyaPemilik: ApprovalJenis[] = ['sunset', 'merge_pr', 'ubah_harga', 'beli_iklan', 'rc_plan'];
    if (claimsOf(c)?.role === 'operator' && hanyaPemilik.includes(approval.jenis)) {
      throw new HttpError(403, 'khusus_pemilik', `keputusan ${approval.jenis} hanya dapat dilakukan pemilik`);
    }
    if (approval.status !== 'menunggu') throw new HttpError(409, 'sudah_diputuskan', `persetujuan berstatus ${approval.status}`);
    if (approval.kedaluwarsa <= Date.now()) {
      await repos.approval.expireDue(Date.now());
      throw new HttpError(409, 'kedaluwarsa', 'persetujuan sudah kedaluwarsa; tindakan tidak dijalankan (FR-9.3)');
    }
    const bagian = body.keputusan === 'setujui' ? 'disetujui' : body.keputusan === 'tolak' ? 'ditolak' : 'revisi';
    const hasil = await orchestrator.decideApproval(id, bagian, aktorOf(c), body.catatan);
    if (!hasil.ok) throw new HttpError(409, 'tidak_dapat_diputuskan', `persetujuan berstatus ${hasil.status}`);
    return c.json({ data: { id, status: hasil.status, efek: hasil.efek ?? null } });
  });

  // ---------------------------------------------------------------- sunset

  app.get('/api/v1/sunset', ownerOperator, async (c) => {
    const { repos } = ctxOf(c);
    return c.json({ data: await repos.sunset.list() });
  });

  app.get('/api/v1/sunset/:id', ownerOperator, async (c) => {
    const { repos } = ctxOf(c);
    const kasus = await repos.sunset.byId(c.req.param('id'));
    if (!kasus) throw new HttpError(404, 'not_found', 'Kasus sunset tidak ditemukan');
    if (!bolehAksesSaas(claimsOf(c), kasus.saasId)) throw new HttpError(403, 'forbidden_saas', 'tidak diizinkan');
    return c.json({ data: kasus });
  });

  app.post('/api/v1/sunset/:id/decision', owner, async (c) => {
    idemKey(c);
    const body = await zodBody(c, SunsetDecisionRequest);
    if (!MFA_TERVERIFIKASI(claimsOf(c), body.mfa_token)) {
      throw new HttpError(403, 'mfa_diperlukan', 'persetujuan sunset memerlukan autentikasi ulang MFA');
    }
    const { orchestrator } = ctxOf(c);
    const keputusan = body.keputusan === 'setujui' ? 'disetujui' : body.keputusan === 'tolak' ? 'ditolak' : 'pengecualian';
    const hasil = await orchestrator.decideSunset(c.req.param('id'), keputusan, aktorOf(c), { ...(body.catatan ? { catatan: body.catatan } : {}), ...(body.tenggat_baru ? { tenggatBaru: body.tenggat_baru } : {}) });
    if (!hasil.ok) throw new HttpError(409, 'tidak_dapat_diputuskan', 'usulan sunset tidak ditemukan atau sudah diputuskan');
    return c.json({ data: hasil });
  });

  app.post('/api/v1/sunset/:id/advance', owner, async (c) => {
    idemKey(c);
    const { orchestrator } = ctxOf(c);
    const hasil = await orchestrator.advanceSunset(c.req.param('id'), aktorOf(c));
    if (!hasil.ok) throw new HttpError(409, 'tahap_tidak_dapat_dilanjutkan', 'sunset belum disetujui atau sudah sampai tahap akhir');
    return c.json({ data: hasil });
  });

  // ---------------------------------------------------------------- kill switch

  app.get('/api/v1/killswitch', ownerOperator, async (c) => {
    const { repos } = ctxOf(c);
    const state = await repos.kill.state();
    return c.json({
      data: {
        global: state.global,
        global_alasan: state.globalAlasan,
        per_saas: [...state.perSaas.entries()].map(([saasId, v]) => ({ saas_id: saasId, aktif: v.aktif, alasan: v.alasan })),
        riwayat: await repos.kill.history(20),
      },
    });
  });

  app.post('/api/v1/killswitch', owner, async (c) => {
    idemKey(c);
    const body = await zodBody(c, KillSwitchRequest);
    const { repos } = ctxOf(c);
    const aktor = aktorOf(c);
    if (body.saas_id) {
      await loadSaas(c, body.saas_id);
      await repos.kill.set('saas', body.aktif, body.alasan, aktor, { saasId: body.saas_id });
      await repos.saas.setPaused(body.saas_id, body.aktif);
    } else {
      await repos.kill.set('global', body.aktif, body.alasan, aktor);
    }
    await repos.event.emit('killswitch.activated', { cakupan: body.saas_id ? 'saas' : 'global', saas_id: body.saas_id ?? null, aktif: body.aktif, alasan: body.alasan }, { saasId: body.saas_id ?? null });
    await repos.audit.append({ aktor, tindakan: body.aktif ? 'killswitch.aktif' : 'killswitch.mati', saasId: body.saas_id ?? null, masukan: { alasan: body.alasan, cakupan: body.saas_id ? 'saas' : 'global' }, waktu: Date.now() });
  // kanal peringatan ditambahkan kemudian; saat ini notifikasi berstatus log
  if (!body.aktif && body.saas_id) {
    // pencabutan kill switch tidak mencabut jeda manual; pemilik memakai `/resume`
  }
    return c.json({ data: { cakupan: body.saas_id ? 'saas' : 'global', saas_id: body.saas_id ?? null, aktif: body.aktif } });
  });

  // ---------------------------------------------------------------- gateway & token layanan

  app.post('/api/v1/gateway/check', anyRole, async (c) => {
    const req = await zodBody(c, GatewayCheckRequest);
    if (!bolehAksesSaas(claimsOf(c), req.saasId)) throw new HttpError(403, 'forbidden_saas', 'token tidak berlaku untuk SaaS Unit ini');
    const claims = claimsOf(c);
    if ((claims?.role === 'service' || claims?.role === 'connector') && claims.fungsi && claims.fungsi !== req.fungsi) {
      throw new HttpError(403, 'forbidden_fungsi', `token layanan hanya berlaku untuk fungsi ${claims.fungsi}`);
    }
    const { repos, orchestrator } = ctxOf(c);
    await rateLimit(c, `gateway:${req.fungsi}`, 120);
    const keputusan = await evaluateGateway(orchestrator.gatewayDeps(), req);
    await repos.audit.append({
      aktor: aktorOf(c),
      tindakan: `gateway.${req.tindakan}`,
      saasId: req.saasId,
      masukan: { idem_key: req.idemKey, payload: req.payload },
      keluaran: { keputusan: keputusan.keputusan, alasan: keputusan.alasan, aturan: keputusan.aturan, approval_id: keputusan.approval_id },
    });
    return c.json({ data: keputusan });
  });

  app.post('/api/v1/service-token', owner, async (c) => {
    const body = await zodBody(
      c,
      z.object({
        saas_id: z.string().min(1),
        fungsi: z.enum(['promosi', 'review', 'kode', 'support', 'parent']),
        job_id: z.string().max(80).optional(),
        ttl_detik: z.number().int().min(60).max(SERVICE_TOKEN_TTL_MAKS_DETIK).default(900),
      }),
    );
    await loadSaas(c, body.saas_id);
    const token = await signServiceToken(
      {
        sub: `service:${body.fungsi}`,
        role: 'service',
        saas: [body.saas_id],
        fungsi: body.fungsi as Fungsi,
        ...(body.job_id ? { job_id: body.job_id } : {}),
      },
      { secret: c.env.JWT_SECRET ?? 'dev-only-secret-change-me-please', ttlDetik: body.ttl_detik },
    );
    return c.json({ data: { token, ttl_detik: body.ttl_detik } });
  });

  // ---------------------------------------------------------------- audit & event

  app.get('/api/v1/audit', owner, zodQuery(AuditQuery), async (c) => {
    const q = queryOf<z.infer<typeof AuditQuery>>(c);
    const { audit, filter } = await recentAudit(c, q);
    return c.json({ data: audit, filter });
  });

  app.get('/api/v1/audit/verify', owner, async (c) => {
    return c.json({ data: await verifyAuditChain(c) });
  });

  app.get('/api/v1/events', ownerOperator, async (c) => {
    const { repos } = ctxOf(c);
    const terakhir = Number(c.req.header('last-event-id') ?? c.req.query('last_id') ?? 0);
    const mulai = terakhir > 0 ? terakhir : Math.max(0, (await repos.event.latestId()) - 5);
    return streamEvents(c, mulai);
  });

  app.get('/api/v1/ops/metrics', owner, async (c) => {
    const { repos } = ctxOf(c);
    const now = Date.now();
    const [pending, antrean, dlq, jobsDone, jobsDead] = await Promise.all([
      repos.approval.countPending(),
      repos.queue.size('agent_jobs'),
      repos.queue.deadLetterSize(),
      countRows(c, "SELECT COUNT(*) AS n FROM agent_job WHERE status = 'done' AND selesai > ?", now - 7 * 86_400_000),
      countRows(c, "SELECT COUNT(*) AS n FROM agent_job WHERE status = 'dead' AND dibuat_pada > ?", now - 7 * 86_400_000),
    ]);
    const biaya = await repos.db.prepare('SELECT SUM(biaya_usd) AS total FROM agent_run WHERE mulai > ?').bind(now - 30 * 86_400_000).first<{ total: number | null }>();
    return c.json({
      data: {
        antrean,
        dead_letter: dlq,
        persetujuan_menunggu: pending,
        job_selesai_7hari: jobsDone,
        job_dead_7hari: jobsDead,
        biaya_agen_30hari_usd: Number(biaya?.total ?? 0),
      },
    });
  });

  // ---------------------------------------------------------------- dashboard & siklus manual

  // `/dashboard` dialihkan permanen ke SPA (URL lama di README & Workers).
  app.get('/dashboard', (c) => c.redirect('/', 301));
  app.get('/dashboard/:id', (c) => c.redirect(`/saas/${encodeURIComponent(c.req.param('id'))}`, 301));

  // Aset ber-hash hasil build (`npm run build` → `apps/web/dist/assets/...`).
  // Path ditulis literal agar terdaftar andal oleh router Hono.
  app.get('/assets/*', async (c) => publishAssets(c, c.req.path.replace(/^\//, '')));
  app.get('/app.js', async (c) => publishAssets(c, 'app.js'));
  app.get('/styles.css', async (c) => publishAssets(c, 'styles.css'));
  app.get('/favicon.svg', async (c) => publishAssets(c, 'favicon.svg'));

  app.post('/api/v1/cycle', owner, async (c) => {
    idemKey(c);
    const body = await zodBody(
      c,
      z.object({ tanggal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), skip_jobs: z.boolean().default(false) }),
    );
    const { orchestrator } = ctxOf(c);
    const hasil = await orchestrator.runCycle({ ...(body.tanggal ? { tanggal: body.tanggal } : {}), skipJobs: body.skip_jobs });
    return c.json({ data: hasil });
  });

  return app;
}

// ------------------------------------------------------------------ helper rute

/**
 * Verifikasi MFA untuk sunset. Token MFA berasal dari penyedia identitas; pada
 * mode pengembangan (`ADMIN_DEV_TOKEN`) token cocok diterima. Di produksi klaim
 * `mfa` dari Access wajib true.
 */
function MFA_TERVERIFIKASI(claims: ReturnType<typeof claimsOf>, token: string): boolean {
  if (!claims) return false;
  if (claims.role !== 'owner') return false;
  if (claims.mfa === true) return true;
  return token.startsWith('dev-') && token.length >= 8;
}

async function countRows(c: Context<AppEnv>, sql: string, ...params: unknown[]): Promise<number> {
  const row = await ctxOf(c).repos.db.prepare(sql).bind(...params).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** SSE pembaruan dashboard (§7.2): event_log sejak `mulai`, lalu polling berkala. */
function streamEvents(c: Context<AppEnv>, mulai: number): Response {
  const { repos } = ctxOf(c);
  const encoder = new TextEncoder();
  let terakhir = mulai;
  let tutup = false;
  const batasMs = 55_000;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const mulaiWaktu = Date.now();
      controller.enqueue(encoder.encode(': terhubung\n\n'));
      while (!tutup && Date.now() - mulaiWaktu < batasMs) {
        const events = await repos.event.since(terakhir, 50);
        for (const e of events) {
          terakhir = e.id;
          const isi = e.payload && typeof e.payload === 'object' ? { ...(e.payload as Record<string, unknown>), saas_id: e.saasId, waktu: e.waktu } : { payload: e.payload, saas_id: e.saasId, waktu: e.waktu };
          controller.enqueue(encoder.encode(`id: ${e.id}\nevent: ${e.nama}\ndata: ${truncate(JSON.stringify(isi), 4000)}\n\n`));
        }
        if (events.length === 0) {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      try {
        controller.close();
      } catch {
        // sudah ditutup oleh klien
      }
    },
    cancel() {
      tutup = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}


