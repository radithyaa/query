/**
 * Definisi tool agen. Setiap tool tulis TIDAK memanggil sistem eksternal secara
 * langsung: ia membentuk permintaan policy gateway. Gateway adalah satu-satunya
 * jalur tool tulis (§3.3 poin 5), sehingga izin, anggaran, kill switch, dan
 * persetujuan ditegakkan di satu tempat.
 */
import type { GatewayCheckRequest, GatewayDecision, Fungsi, Tindakan } from '@portfolio/shared';

export interface ToolContext {
  saasId: string;
  fungsi: Fungsi;
  runId: string;
  jobId: string;
  /**
   * Panggil policy gateway. Nilai `null` berarti mode lokal tanpa gateway aktif
   * (semua tindakan tulis ditolak).
   */
  gateway: ((req: GatewayCheckRequest) => Promise<GatewayDecision>) | null;
  /** Efek setelah gateway mengizinkan (mis. menulis tabel lokal) */
  efek: (tindakan: Tindakan, payload: Record<string, unknown>, keputusan: GatewayDecision) => Promise<{ ok: boolean; data?: unknown }>;
  now: number;
}

export interface ToolSpec {
  nama: Tindakan;
  deskripsi: string;
  /** JSON Schema sederhana untuk ditampilkan ke model */
  skemaParameter: Record<string, string>;
  /** fungsi agen yang diizinkan memakai tool ini (§3.6) */
  fungsiDiizinkan: ReadonlySet<Fungsi>;
  jenisPersetujuan: GatewayCheckRequest['jenis_persetujuan'];
  jalankan: (ctx: ToolContext, args: Record<string, unknown>) => Promise<{ keputusan: GatewayDecision; data?: unknown }>;
}

function izinkan(...fungsi: Fungsi[]): ReadonlySet<Fungsi> {
  return new Set(fungsi);
}

export const TOOLS: ToolSpec[] = [
  {
    nama: 'terbit_post',
    deskripsi: 'Terbitkan konten ke kanal resmi sesuai tingkat persetujuan yang berlaku.',
    skemaParameter: { kanal: 'string', judul: 'string', body: 'string', media_url: 'string|null' },
    fungsiDiizinkan: izinkan('promosi'),
    jenisPersetujuan: 'terbit_post',
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'terbit_post', args, 'Menerbitkan konten promosi ke kanal resmi');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('terbit_post', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
  {
    nama: 'jadwalkan_post',
    deskripsi: 'Jadwalkan konten untuk terbit di waktu mendatang.',
    skemaParameter: { kanal: 'string', jadwal: 'string', judul: 'string', body: 'string' },
    fungsiDiizinkan: izinkan('promosi'),
    jenisPersetujuan: 'terbit_post',
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'jadwalkan_post', args, 'Menjadwalkan konten promosi');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('jadwalkan_post', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
  {
    nama: 'balas_ulasan',
    deskripsi: 'Terbitkan balasan ulasan Play Store yang sudah disetujui.',
    skemaParameter: { review_id: 'string', teks: 'string' },
    fungsiDiizinkan: izinkan('review'),
    jenisPersetujuan: 'balas_ulasan',
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'balas_ulasan', args, 'Membalas ulasan pengguna di Play Store');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('balas_ulasan', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
  {
    nama: 'buat_issue',
    deskripsi: 'Buat issue GitHub dari tema bug yang terverifikasi.',
    skemaParameter: { judul: 'string', body: 'string', labels: 'string[]' },
    fungsiDiizinkan: izinkan('review', 'kode'),
    jenisPersetujuan: 'buat_issue',
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'buat_issue', args, 'Membuat issue di repo SaaS');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('buat_issue', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
  {
    nama: 'buka_pr',
    deskripsi: 'Buka Pull Request dari branch agent/* (tidak pernah merge).',
    skemaParameter: { judul: 'string', body: 'string', branch: 'string', issue_asal: 'string|null' },
    fungsiDiizinkan: izinkan('kode'),
    jenisPersetujuan: undefined,
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'buka_pr', args, 'Membuka Pull Request untuk ditinjau manusia');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('buka_pr', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
  {
    nama: 'merge_pr',
    deskripsi: 'Merge PR ke branch utama. SELALU memerlukan persetujuan manusia.',
    skemaParameter: { pr: 'number', repo: 'string' },
    fungsiDiizinkan: izinkan('kode'),
    jenisPersetujuan: 'merge_pr',
    jalankan: async (ctx, args) => ({ keputusan: await panggilGateway(ctx, 'merge_pr', args, 'Merge PR ke branch utama') }),
  },
  {
    nama: 'deploy',
    deskripsi: 'Deploy ke production. SELALU memerlukan persetujuan manusia.',
    skemaParameter: { versi: 'string' },
    fungsiDiizinkan: izinkan('kode'),
    jenisPersetujuan: undefined,
    jalankan: async (ctx, args) => ({ keputusan: await panggilGateway(ctx, 'deploy', args, 'Deploy ke production') }),
  },
  {
    nama: 'ubah_harga',
    deskripsi: 'Ubah harga produk. SELALU memerlukan persetujuan manusia.',
    skemaParameter: { paket: 'string', harga_baru: 'number' },
    fungsiDiizinkan: izinkan('parent'),
    jenisPersetujuan: 'ubah_harga',
    jalankan: async (ctx, args) => ({ keputusan: await panggilGateway(ctx, 'ubah_harga', args, 'Mengubah harga produk') }),
  },
  {
    nama: 'kirim_email_massal',
    deskripsi: 'Kirim email ke daftar pelanggan. SELALU memerlukan persetujuan manusia.',
    skemaParameter: { subjek: 'string', body: 'string', jumlah_penerima: 'number' },
    fungsiDiizinkan: izinkan('promosi'),
    jenisPersetujuan: 'kirim_email_massal',
    jalankan: async (ctx, args) => ({ keputusan: await panggilGateway(ctx, 'kirim_email_massal', args, 'Mengirim email ke daftar pelanggan') }),
  },
  {
    nama: 'beli_iklan',
    deskripsi: 'Belanja iklan berbayar di atas anggaran. SELALU memerlukan persetujuan manusia.',
    skemaParameter: { platform: 'string', biaya_usd: 'number' },
    fungsiDiizinkan: izinkan('promosi'),
    jenisPersetujuan: 'beli_iklan',
    jalankan: async (ctx, args) => ({ keputusan: await panggilGateway(ctx, 'beli_iklan', args, 'Membeli iklan berbayar') }),
  },
  {
    nama: 'sunset',
    deskripsi: 'Usulkan penghentian SaaS Unit. SELALU memerlukan persetujuan pemilik.',
    skemaParameter: { alasan: 'string' },
    fungsiDiizinkan: izinkan('parent'),
    jenisPersetujuan: 'sunset',
    jalankan: async (ctx, args) => ({ keputusan: await panggilGateway(ctx, 'sunset', args, 'Mengusulkan sunset SaaS Unit') }),
  },
  {
    nama: 'jalankan_render',
    deskripsi: 'Kirim skrip video ke worker perenderan.',
    skemaParameter: { skrip: 'object', durasi_detik: 'number' },
    fungsiDiizinkan: izinkan('promosi'),
    jenisPersetujuan: 'render_video',
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'jalankan_render', args, 'Merender video promosi');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('jalankan_render', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
  {
    nama: 'simpan_konten',
    deskripsi: 'Simpan draf konten (caption, kalender, skrip) ke pustaka konten.',
    skemaParameter: { kanal: 'string', judul: 'string', body: 'string' },
    fungsiDiizinkan: izinkan('promosi'),
    jenisPersetujuan: undefined,
    jalankan: async (ctx, args) => {
      const keputusan = await panggilGateway(ctx, 'simpan_konten', args, 'Menyimpan draf konten');
      const data = keputusan.keputusan === 'izinkan' ? await ctx.efek('simpan_konten', args, keputusan) : undefined;
      return { keputusan, data };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.nama, t]));

export function toolsFor(fungsi: Fungsi): ToolSpec[] {
  return TOOLS.filter((t) => t.fungsiDiizinkan.has(fungsi));
}

/** Matriks izin §3.6: true bila fungsi boleh memanggil tindakan ini. */
export function bolehPakai(fungsi: Fungsi, tindakan: Tindakan): boolean {
  const tool = BY_NAME.get(tindakan);
  return Boolean(tool?.fungsiDiizinkan.has(fungsi));
}

async function panggilGateway(ctx: ToolContext, tindakan: Tindakan, args: Record<string, unknown>, ringkasan: string): Promise<GatewayDecision> {
  if (!ctx.gateway) {
    return { keputusan: 'tolak', alasan: 'Policy gateway tidak aktif: tindakan tulis ditolak (mode lokal)', approval_id: null, sisa_anggaran_usd: null, aturan: ['gateway_nonaktif'] };
  }
  const spec = BY_NAME.get(tindakan);
  const biaya = typeof args.biaya_usd === 'number' ? args.biaya_usd : undefined;
  return ctx.gateway({
    saasId: ctx.saasId,
    fungsi: ctx.fungsi,
    tindakan,
    idemKey: `${ctx.runId}:${tindakan}:${JSON.stringify(args).length}`,
    payload: args,
    ringkasan_dampak: ringkasan,
    ...(spec?.jenisPersetujuan ? { jenis_persetujuan: spec.jenisPersetujuan } : {}),
    ...(biaya === undefined ? {} : { biaya_perkiraan_usd: biaya }),
    run_id: ctx.runId,
    job_id: ctx.jobId,
  });
}
