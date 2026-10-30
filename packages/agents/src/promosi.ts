/**
 * Agen Promosi (FR-2): kalender konten mingguan, caption/hashtag/alt, skrip video
 * JSON, draf promosi lain, pemeriksaan klaim sebelum terbit.
 */
import { z } from 'zod';
import { CONTENT_KANAL, round, type ContentKanal } from '@portfolio/shared';
import { connectorCtx, daftarKlaimTerlarang, faktaProduk, periksaKlaim, type AgentOutcome, type AgentRuntime } from './context.ts';
import { runAgentLoop, tierUntuk } from './loop.ts';
import { toolsFor } from './tools.ts';
import { bungkusDataLuar } from './policy.ts';

export const SkripVideo = z.object({
  judul: z.string().max(160),
  durasi_detik: z.number().int().positive().max(90),
  aspek: z.enum(['9:16', '1:1', '16:9']),
  scenes: z
    .array(
      z.object({
        urutan: z.number().int().positive(),
        durasi_detik: z.number().positive().max(30),
        visual: z.string().max(400),
        teks_layar: z.string().max(160),
        narasi: z.string().max(400),
      }),
    )
    .min(1)
    .max(12),
  musik: z.string().max(120).optional(),
  cta: z.string().max(120),
});

export const ItemKontenSchema = z.object({
  kanal: z.enum(CONTENT_KANAL),
  judul: z.string().max(200),
  body: z.string().max(4000),
  hashtag: z.array(z.string().max(40)).max(20).default([]),
  alt_text: z.string().max(400).optional(),
  jadwal: z.string().max(40).optional(),
  skrip_video: SkripVideo.optional(),
});

export const KeluaranPromosi = z.object({
  kalender: z.array(ItemKontenSchema).max(14),
  pemeriksaan_klaim: z.array(
    z.object({ judul: z.string().max(200), lulus: z.boolean(), pelanggaran: z.array(z.string()).default([]) }),
  ),
  catatan: z.string().max(1000).default(''),
});

export type KeluaranPromosi = z.infer<typeof KeluaranPromosi>;
export type ItemKonten = z.infer<typeof ItemKontenSchema>;

const HARI = ['Senin', 'Rabu', 'Jumat', 'Sabtu'];

/** Kalender konten deterministik berbasis fakta produk; tidak mengarang klaim. */
export function susunKalender(rt: AgentRuntime, minggu: string): ItemKonten[] {
  const fakta = faktaProduk(rt);
  const tanda = rt.saas.config.tanda_ai ? '\n\n(Dibuat dengan bantuan AI; ditinjau oleh tim.)' : '';
  const ide: Array<{ kanal: ContentKanal; judul: string; body: string; hashtag: string[]; video?: boolean }> = [
    {
      kanal: 'instagram',
      judul: `Tips memakai ${fakta.nama}`,
      body: `3 cara memanfaatkan laporan otomatis di ${fakta.nama}:\n1. Buka menu Laporan.\n2. Pilih periode.\n3. Ekspor ke PDF untuk dibagikan.\n\nSelamat bekerja lebih cepat bersama tim Anda.${tanda}`,
      hashtag: ['produktivitas', 'laporanotomatis', 'timkerja'],
    },
    {
      kanal: 'instagram',
      judul: 'Reels: alur laporan dalam 20 detik',
      body: `Lihat betapa mudahnya membuat laporan mingguan dengan ${fakta.nama}. Tonton sampai akhir untuk melihat ekspor PDF.${tanda}`,
      hashtag: ['reels', 'produktivitas', 'aplikasibisnis'],
      video: true,
    },
    {
      kanal: 'blog',
      judul: `Panduan singkat sinkronisasi ${fakta.nama}`,
      body: `Sinkronisasi antar perangkat membantu tim melihat data yang sama. Buka Pengaturan > Sinkronisasi dan masuk dengan akun yang sama di setiap perangkat. Sinkronisasi berjalan otomatis saat perangkat online.${tanda}`,
      hashtag: [],
    },
    {
      kanal: 'store_listing',
      judul: 'Deskripsi toko aplikasi',
      body: `${fakta.nama} membantu ${fakta.targetPengguna} menyelesaikan laporan lebih cepat. Fitur: laporan otomatis, sinkronisasi perangkat, ekspor PDF, dan mode tim.${tanda}`,
      hashtag: [],
    },
  ];

  return ide.map((i, idx) => {
    const jadwal = `${minggu}-${HARI[idx % HARI.length]!.toLowerCase()}-09:00`;
    const item: ItemKonten = {
      kanal: i.kanal,
      judul: i.judul,
      body: i.body,
      hashtag: i.hashtag,
      jadwal,
      alt_text: i.kanal === 'instagram' ? `Tangkapan layar aplikasi ${fakta.nama} menampilkan menu laporan` : undefined,
    };
    if (i.video) {
      item.skrip_video = {
        judul: 'Alur laporan 20 detik',
        durasi_detik: 20,
        aspek: '9:16',
        scenes: [
          { urutan: 1, durasi_detik: 3, visual: 'Layar pembuka: logo dan nama produk', teks_layar: `Laporan mingguan dalam 20 detik`, narasi: 'Begini cara membuat laporan mingguan.' },
          { urutan: 2, durasi_detik: 7, visual: 'Rekaman layar membuka menu Laporan', teks_layar: 'Pilih periode', narasi: 'Buka menu Laporan lalu pilih periode.' },
          { urutan: 3, durasi_detik: 6, visual: 'Rekaman layar menekan Ekspor > PDF', teks_layar: 'Ekspor PDF', narasi: 'Tekan ekspor dan pilih PDF.' },
          { urutan: 4, durasi_detik: 4, visual: 'Logo produk dan tombol unduh', teks_layar: 'Coba sekarang', narasi: 'Unduh dan coba sekarang.' },
        ],
        musik: 'upbeat-corporate',
        cta: 'Unduh di Play Store',
      };
    }
    return item;
  });
}

export async function jalankanPromosi(rt: AgentRuntime, opts: { mingguan: boolean; minggu: string }): Promise<AgentOutcome<KeluaranPromosi>> {
  const fakta = faktaProduk(rt);
  const terlarang = daftarKlaimTerlarang(rt);
  const performa = rt.metrics.slice(-7).map((m) => ({ tanggal: m.tanggal, rating: m.toko_aplikasi?.rating_rata2 ?? null, mau: m.produk?.mau ?? null }));

  const tools = toolsFor('promosi');
  const loop = await runAgentLoop({
    sistem: `Kamu Agen Promosi untuk ${rt.saas.nama}. Susun konten yang jujur, sesuai panduan merek, dan hanya memakai fakta produk yang diberikan. Jangan membuat testimoni atau angka karangan.`,
    tugas: `Fakta produk:\n${JSON.stringify(fakta)}\n\nMetrik konten 7 hari:\n${JSON.stringify(performa)}\n\nKalender minggu ${opts.minggu} (mode ${opts.mingguan ? 'mingguan' : 'harian'}): ${JSON.stringify(susunKalender(rt, opts.minggu))}\n\nKlaim terlarang: ${terlarang.join('; ')}\nPanduan merek: ${rt.saas.config.panduan_merek ?? 'ramah, ringkas, tanpa klaim berlebihan'}`,
    tools,
    tier: tierUntuk('tulis_konten'),
    skemaKeluaran: KeluaranPromosi,
    maxLangkah: rt.batasLangkah,
    maxToken: 24_000,
    budget: { sisaUsd: rt.sisaAnggaranUsd },
    jalankanTool: async (tool, argumen) => {
      const hasil = await tool.jalankan(rt.tools, argumen);
      return { observasi: `${hasil.keputusan.keputusan}: ${hasil.keputusan.alasan}` };
    },
    model: rt.model,
    logger: rt.logger,
    now: () => rt.now,
    fallback: () => {
      const kalender = susunKalender(rt, opts.minggu);
      const pemeriksaan = kalender.map((k) => {
        const cek = periksaKlaim(`${k.judul} ${k.body} ${k.hashtag.join(' ')}`, terlarang);
        return { judul: k.judul, lulus: cek.lulus, pelanggaran: cek.pelanggaran };
      });
      const pertama = kalender[0];
      return {
        tool: pertama ? 'simpan_konten' : null,
        argumen: pertama ? { kanal: pertama.kanal, judul: pertama.judul, body: pertama.body, hashtag: pertama.hashtag, jadwal: pertama.jadwal } : {},
        keluaran: { kalender, pemeriksaan_klaim: pemeriksaan, catatan: `Kalender ${kalender.length} item untuk minggu ${opts.minggu}; konten menunggu persetujuan.` },
      };
    },
  });

  // Pemeriksaan klaim final atas seluruh item (FR-2.7) — item gagal tidak boleh terbit
  const pemeriksaan = loop.keluaran.kalender.map((k) => {
    const cek = periksaKlaim(`${k.judul} ${k.body} ${k.hashtag.join(' ')}`, terlarang);
    return { judul: k.judul, lulus: cek.lulus, pelanggaran: cek.pelanggaran };
  });
  loop.keluaran.pemeriksaan_klaim = pemeriksaan;

  const lulus = pemeriksaan.filter((p) => p.lulus).length;
  return {
    hasil: loop.keluaran,
    ringkasanMemori: `Promosi ${opts.minggu}: ${loop.keluaran.kalender.length} item, ${lulus} lolos pemeriksaan klaim. Rata-rata rating 7 hari ${round(performa.map((p) => p.rating ?? 0).reduce((a, b) => a + b, 0) / Math.max(1, performa.length), 2)}.`,
    biayaUsd: loop.biayaUsd,
    tokenMasuk: loop.tokenMasuk,
    tokenKeluar: loop.tokenKeluar,
    model: loop.model,
    langkah: loop.langkah,
    ditahan: loop.ditahan,
  };
}

export function connectorInstagram(rt: AgentRuntime) {
  return connectorCtx(rt, 'instagram');
}
