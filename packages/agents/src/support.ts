/**
 * Agen Support (FR-5): jawab pertanyaan dari knowledge base, eskalasi bila keyakinan
 * rendah, dan catat topik berulang. Tidak pernah menjanjikan refund, harga, atau fitur.
 */
import { z } from 'zod';
import { redactPii } from '@portfolio/shared';
import { connectorCtx, type AgentOutcome, type AgentRuntime } from './context.ts';
import { runAgentLoop, tierUntuk } from './loop.ts';
import { bungkusDataLuar, deteksiInjeksi } from './policy.ts';

export const KeluaranSupport = z.object({
  jawaban: z.array(
    z.object({
      pertanyaan: z.string().max(1000),
      jawaban: z.string().max(2000).nullable(),
      keyakinan: z.number().min(0).max(1),
      eskalasi: z.boolean(),
      alasan: z.string().max(400),
    }),
  ),
  topik_berulang: z.array(z.object({ topik: z.string().max(120), jumlah: z.number().int().nonnegative() })),
});

export type KeluaranSupport = z.infer<typeof KeluaranSupport>;

export interface KnowledgeBase {
  entri: Array<{ pertanyaan: string; jawaban: string; kataKunci: string[] }>;
}

export const KB_DEFAULT: KnowledgeBase = {
  entri: [
    {
      pertanyaan: 'Cara sinkronisasi antar perangkat?',
      jawaban: 'Buka Pengaturan > Sinkronisasi, lalu masuk dengan akun yang sama di setiap perangkat. Sinkronisasi berjalan otomatis saat perangkat online.',
      kataKunci: ['sinkron', 'perangkat', 'akun'],
    },
    {
      pertanyaan: 'Bagaimana mengekspor laporan ke PDF?',
      jawaban: 'Buka menu Laporan, pilih periode, lalu tekan tombol Ekspor > PDF. File akan tersimpan di folder Unduhan atau dibagikan sesuai pilihan Anda.',
      kataKunci: ['ekspor', 'pdf', 'laporan'],
    },
    {
      pertanyaan: 'Aplikasi crash setelah update',
      jawaban: 'Silakan perbarui aplikasi ke versi terbaru dari Play Store, lalu hapus cache melalui Pengaturan > Aplikasi > Hapus cache. Bila masih terjadi, laporkan perangkat dan versi aplikasi Anda.',
      kataKunci: ['crash', 'update', 'error'],
    },
    {
      pertanyaan: 'Apakah ada refund?',
      jawaban: 'Untuk pengembalian dana, kebijakan penyedia pembayaran dan syarat layanan berlaku; tim kami akan meneruskan permintaan Anda ke tim keuangan untuk ditinjau.',
      kataKunci: ['refund', 'dana', 'uang'],
      // jawaban ini hanya informasi kebijakan; agen tidak boleh menjanjikan refund
    },
  ],
};

const LARANGAN_BEBAS = [
  /kami\s+(akan\s+)?(memberikan|mengembalikan)\s+(refund|dana)/i,
  /harga\s+(akan\s+)?(diturunkan|kami turunkan)\s+dijamin/i,
  /fitur\s+baru\s+(akan|pasti)\s+dirilis/i,
];

/** Tentukan apakah jawaban melanggar larangan janji (refund/harga/fitur). */
export function periksaLaranganJanji(teks: string): string[] {
  return LARANGAN_BEBAS.filter((re) => re.test(teks)).map((re) => re.source);
}

function cariKb(kb: KnowledgeBase, pertanyaan: string): { entri: KnowledgeBase['entri'][number]; skor: number } | null {
  const lower = pertanyaan.toLowerCase();
  let best: { entri: KnowledgeBase['entri'][number]; skor: number } | null = null;
  for (const entri of kb.entri) {
    const cocok = entri.kataKunci.filter((k) => lower.includes(k)).length;
    if (cocok > 0 && (!best || cocok > best.skor)) best = { entri, skor: cocok };
  }
  return best;
}

export interface TiketMasuk {
  id: string;
  pertanyaan: string;
}

export async function ambilTiket(rt: AgentRuntime): Promise<TiketMasuk[]> {
  // Sumber tiket dapat berupa konektor support; pada mode lokal pakai antrean tetap.
  const dariDetail = rt.connectorSecret('support');
  void dariDetail;
  return [
    { id: 't-1', pertanyaan: 'Bagaimana cara sinkronisasi antar perangkat saya?' },
    { id: 't-2', pertanyaan: 'Aplikasi crash setelah update, tolong bantu.' },
    { id: 't-3', pertanyaan: 'Bisa minta refund? saya tidak puas.' },
    { id: 't-4', pertanyaan: 'Hubungi budi@contoh.id, minta harga khusus untuk tim 50 orang.' },
  ];
}

export async function jalankanSupport(rt: AgentRuntime): Promise<AgentOutcome<KeluaranSupport>> {
  const tiket = (await ambilTiket(rt)).map((t) => ({ ...t, pertanyaan: redactPii(t.pertanyaan) }));
  const kb = KB_DEFAULT;

  const loop = await runAgentLoop({
    sistem: `Kamu Agen Support untuk ${rt.saas.nama}. Jawab hanya dari knowledge base. Jangan pernah menjanjikan refund, harga, atau fitur baru. Bila keyakinan rendah, eskalasi ke manusia.`,
    tugas: `Tiket:\n${tiket.map((t) => bungkusDataLuar(`tiket:${t.id}`, t.pertanyaan)).join('\n')}\n\nKnowledge base:\n${kb.entri.map((e) => `Q: ${e.pertanyaan}\nA: ${e.jawaban}`).join('\n\n')}`,
    tools: [],
    tier: tierUntuk('jawab_support'),
    skemaKeluaran: KeluaranSupport,
    maxLangkah: Math.min(rt.batasLangkah, 3),
    maxToken: 12_000,
    budget: { sisaUsd: rt.sisaAnggaranUsd },
    jalankanTool: async () => ({ observasi: 'tidak ada tool' }),
    model: rt.model,
    logger: rt.logger,
    now: () => rt.now,
    fallback: () => {
      const jawaban = tiket.map((t) => {
        const injeksi = deteksiInjeksi(t.pertanyaan).mencurigakan;
        const ketemu = cariKb(kb, t.pertanyaan);
        if (injeksi) {
          return { pertanyaan: t.pertanyaan.slice(0, 200), jawaban: null, keyakinan: 0.1, eskalasi: true, alasan: 'Teks memuat pola instruksi berbahaya; dieskalasi ke manusia' };
        }
        const keyakinan = ketemu ? Math.min(0.95, 0.6 + ketemu.skor * 0.15) : 0.2;
        const lanjutan = /refund|dana/i.test(t.pertanyaan) && ketemu ? ' Permintaan Anda kami teruskan ke tim keuangan untuk ditinjau sesuai kebijakan.' : '';
        return {
          pertanyaan: t.pertanyaan.slice(0, 200),
          jawaban: keyakinan >= 0.6 && ketemu ? `${ketemu.entri.jawaban}${lanjutan}` : null,
          keyakinan,
          eskalasi: !ketemu || keyakinan < 0.6,
          alasan: ketemu ? `Cocok dengan KB (${ketemu.entri.pertanyaan})` : 'Tidak ada entri KB yang cocok',
        };
      });
      const topik = new Map<string, number>();
      for (const t of tiket) {
        const k = cariKb(kb, t.pertanyaan)?.entri.pertanyaan ?? 'pertanyaan umum';
        topik.set(k, (topik.get(k) ?? 0) + 1);
      }
      return {
        tool: null,
        argumen: {},
        keluaran: { jawaban, topik_berulang: [...topik.entries()].map(([topik, jumlah]) => ({ topik, jumlah })) },
      };
    },
  });

  // Pastikan tidak ada janji refund/harga/fitur yang lolos ke pengguna
  for (const j of loop.keluaran.jawaban) {
    if (j.jawaban && periksaLaranganJanji(j.jawaban).length > 0) {
      j.jawaban = null;
      j.eskalasi = true;
      j.alasan = 'Jawaban memuat janji yang dilarang; dieskalasi ke manusia';
    }
  }
  void connectorCtx;

  return {
    hasil: loop.keluaran,
    ringkasanMemori: `Support: ${loop.keluaran.jawaban.filter((j) => !j.eskalasi).length}/${loop.keluaran.jawaban.length} dijawab, ${loop.keluaran.jawaban.filter((j) => j.eskalasi).length} eskalasi.`,
    biayaUsd: loop.biayaUsd,
    tokenMasuk: loop.tokenMasuk,
    tokenKeluar: loop.tokenKeluar,
    model: loop.model,
    langkah: loop.langkah,
    ditahan: loop.ditahan,
  };
}
