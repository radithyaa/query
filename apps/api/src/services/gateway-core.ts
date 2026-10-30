/**
 * Policy gateway (§3.3 poin 5, §11.5, §5.8): satu-satunya jalur tool tulis.
 * Keputusan deterministik dari tabel:
 *
 *   kill switch × status SaaS/otonomi × izin fungsi × anggaran × rate limit × jenis tindakan
 *
 * Urutan pemeriksaan (penolakan lebih awal menang):
 *   1. kill switch (global / SaaS)
 *   2. SaaS Unit berhenti/diarsipkan
 *   3. izin fungsi untuk tindakan (matriks §3.6)
 *   4. jeda per SaaS
 *   5. rate limit
 *   6. anggaran (habis → tolak; perkiraan biaya melebihi sisa → tolak)
 *   7. tindakan yang selalu HITL (FR-9.2)
 *   8. tingkat otonomi (draf → perlu persetujuan, dst.)
 */
import { DEFAULT_APPROVAL_TTL_MS, SELALU_HITL, type GatewayCheckRequest, type GatewayDecision, type Otonomi, type SaasStatus } from '@portfolio/shared';
import { bolehPakai } from '@portfolio/agents';

export interface GatewayContext {
  saas: {
    id: string;
    status: SaasStatus;
    paused: boolean;
    otonomi: Partial<Record<string, Otonomi>>;
    /** persentase anggaran yang sudah terpakai (0..>1) */
    anggaranTerpakaiPersen: number | null;
    sisaAnggaranUsd: number | null;
    /** batas nomor anggaran default bila fungsi tidak punya anggaran eksplisit */
    batasAnggaranFungsiUsd: number | null;
  };
  killGlobal: boolean;
  killSaas: boolean;
  killAlasan: string | null;
  rateTerlampaui: boolean;
  now: number;
  ttlMs?: number;
}

export interface GatewayOutcome extends GatewayDecision {
  /** jenis persetujuan yang harus dibuat bila keputusan perlu_persetujuan */
  jenisPersetujuan: string | null;
  kedaluwarsa: number | null;
  /** true bila keputusan ini harus memakai (dan mungkin membuat) baris `approval` yang sudah ada untuk idemKey */
  reuseIdemKey: string;
}

const OTONOMI_BERLAKU: Record<string, Otonomi> = {
  promosi: 'draf',
  review: 'draf',
  kode: 'draf',
  support: 'draf',
  parent: 'draf',
};

/** Tindakan yang boleh tanpa persetujuan pada tingkat `otonom`. */
const BOLEH_OTONOM: ReadonlySet<string> = new Set([
  'balas_ulasan',
  'buat_issue',
  'buka_pr',
  'jalankan_render',
  'simpan_konten',
  'jadwalkan_post',
  'terbit_post',
]);

/** Tingkat otonomi yang dibutuhkan agar tindakan tidak perlu persetujuan. */
export function otonomiBerlaku(ctx: GatewayContext, fungsi: string): Otonomi {
  return ctx.saas.otonomi[fungsi] ?? OTONOMI_BERLAKU[fungsi] ?? 'draf';
}

const JENIS_DEFAULT: Record<string, string> = {
  terbit_post: 'terbit_post',
  jadwalkan_post: 'terbit_post',
  balas_ulasan: 'balas_ulasan',
  buat_issue: 'buat_issue',
  buka_pr: 'lainnya',
  merge_pr: 'merge_pr',
  deploy: 'lainnya',
  ubah_harga: 'ubah_harga',
  kirim_email_massal: 'kirim_email_massal',
  beli_iklan: 'beli_iklan',
  sunset: 'sunset',
  jalankan_render: 'render_video',
  simpan_konten: 'lainnya',
};

export function decideGateway(req: GatewayCheckRequest, ctx: GatewayContext): GatewayOutcome {
  const aturan: string[] = [];
  const ttl = ctx.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const dasar = {
    approval_id: null,
    sisa_anggaran_usd: ctx.saas.sisaAnggaranUsd,
    aturan,
    jenisPersetujuan: req.jenis_persetujuan ?? JENIS_DEFAULT[req.tindakan] ?? 'lainnya',
    kedaluwarsa: ctx.now + ttl,
    reuseIdemKey: req.idemKey,
  } satisfies Partial<GatewayOutcome>;

  const tolak = (alasan: string, rule: string): GatewayOutcome => {
    aturan.push(rule);
    return { ...dasar, keputusan: 'tolak', alasan, approval_id: null } as GatewayOutcome;
  };
  const setuju = (alasan: string, rule: string): GatewayOutcome => {
    aturan.push(rule);
    return { ...dasar, keputusan: 'izinkan', alasan, approval_id: null } as GatewayOutcome;
  };
  const persetujuan = (alasan: string, rule: string): GatewayOutcome => {
    aturan.push(rule);
    return { ...dasar, keputusan: 'perlu_persetujuan', alasan, approval_id: null } as GatewayOutcome;
  };

  // 1. kill switch
  if (ctx.killGlobal) return tolak(`Kill switch global aktif${ctx.killAlasan ? `: ${ctx.killAlasan}` : ''}`, 'killswitch:global');
  if (ctx.killSaas) return tolak(`Kill switch SaaS Unit aktif${ctx.killAlasan ? `: ${ctx.killAlasan}` : ''}`, 'killswitch:saas');

  // 2. status SaaS Unit
  if (ctx.saas.status === 'dihentikan' || ctx.saas.status === 'diarsipkan') {
    return tolak(`SaaS Unit berstatus ${ctx.saas.status}; tidak ada tindakan tulis`, `status:${ctx.saas.status}`);
  }
  if (ctx.saas.status === 'dalam_sunset' && req.tindakan !== 'sunset') {
    return tolak('SaaS Unit dalam proses sunset; hanya tahapan sunset yang diizinkan', 'status:dalam_sunset');
  }

  // 3. matriks izin per fungsi (§3.6)
  if (!bolehPakai(req.fungsi, req.tindakan)) {
    return tolak(`Fungsi ${req.fungsi} tidak memiliki izin untuk tindakan ${req.tindakan}`, 'izin:matriks');
  }

  // 4. jeda per SaaS
  if (ctx.saas.paused) return tolak('Agen SaaS Unit dijeda oleh pemilik', 'jeda:saas');

  // 5. rate limit
  if (ctx.rateTerlampaui) return tolak('Rate limit tindakan tulis terlampaui', 'ratelimit');

  // 6. anggaran
  const biaya = req.biaya_perkiraan_usd ?? 0;
  const sisa = ctx.saas.sisaAnggaranUsd;
  if (sisa !== null && sisa <= 0) return tolak('Anggaran agen habis', 'anggaran:habis');
  if (sisa !== null && biaya > sisa) {
    return tolak(`Perkiraan biaya $${biaya} melebihi sisa anggaran $${sisa}`, 'anggaran:biaya');
  }
  if (ctx.saas.anggaranTerpakaiPersen !== null && ctx.saas.anggaranTerpakaiPersen >= 100) {
    return tolak('Anggaran bulanan fungsi sudah terpakai penuh', 'anggaran:100');
  }

  // 7. tindakan yang selalu butuh persetujuan manusia (FR-9.2)
  if (SELALU_HITL.has(req.tindakan)) {
    return persetujuan(`Tindakan ${req.tindakan} selalu memerlukan persetujuan manusia`, 'hitl:wajib');
  }

  // 8. tingkat otonomi
  const level = otonomiBerlaku(ctx, req.fungsi);
  if (level === 'draf') {
    return persetujuan(`Fungsi ${req.fungsi} pada tingkat Draf: agen hanya menyiapkan, manusia yang bertindak`, 'otonomi:draf');
  }
  if (level === 'persetujuan') {
    return persetujuan(`Fungsi ${req.fungsi} pada tingkat Persetujuan: tindakan menunggu manusia`, 'otonomi:persetujuan');
  }
  // otonom terbatas
  if (!BOLEH_OTONOM.has(req.tindakan)) {
    return persetujuan(`Tindakan ${req.tindakan} berada di luar daftar otonom terbatas`, 'otonomi:batas');
  }
  return setuju(`Tindakan ${req.tindakan} diizinkan pada tingkat otonom terbatas`, 'otonomi:otonom');
}

/** Pemeriksaan konsistensi tabel: semua tindakan di SELALU_HITL tidak bisa diizinkan otonom. */
export function tabelKonsisten(): boolean {
  for (const t of SELALU_HITL) {
    if (BOLEH_OTONOM.has(t)) return false;
  }
  return true;
}
