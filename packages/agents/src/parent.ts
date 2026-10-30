/**
 * Agen Induk (FR-6): ringkasan harian/mingguan portofolio, rekomendasi tindakan,
 * dan usulan perubahan status. Tidak punya akses tulis ke repo, media sosial,
 * atau billing; usulan dijalankan lewat Health engine dan persetujuan pemilik.
 */
import { z } from 'zod';
import { KOMPONEN_LABELS, round, type ContentKanal, type HealthResult } from '@portfolio/shared';
import type { AgentOutcome, AgentRuntime } from './context.ts';
import { runAgentLoop, tierUntuk } from './loop.ts';
import { bungkusDataLuar } from './policy.ts';

export const Rekomendasi = z.object({
  saas_id: z.string().max(80),
  prioritas: z.enum(['tinggi', 'sedang', 'rendah']),
  rekomendasi: z.string().max(600),
  dasar: z.string().max(600),
});

export const UsulanStatus = z.object({
  saas_id: z.string().max(80),
  dari: z.string().max(40),
  ke: z.string().max(40),
  alasan: z.string().max(800),
  butuh_persetujuan: z.boolean().default(true),
});

export const KeluaranParent = z.object({
  periode: z.enum(['harian', 'mingguan']),
  ringkasan_portofolio: z.string().max(4000),
  ringkasan_per_saas: z.array(
    z.object({
      saas_id: z.string().max(80),
      nama: z.string().max(160),
      skor: z.number(),
      status: z.string().max(40),
      sorotan: z.array(z.string().max(300)).max(6),
    }),
  ),
  rekomendasi: z.array(Rekomendasi).max(20),
  usulan_status: z.array(UsulanStatus).max(10).default([]),
});

export type KeluaranParent = z.infer<typeof KeluaranParent>;

export interface SaasSnapshot {
  id: string;
  nama: string;
  slug: string;
  status: string;
  health: HealthResult | null;
  mrr: number | null;
  signup: number | null;
  rating: number | null;
  biayaAgen: number | null;
  kontenTerbit: number;
  prTerbuka: number;
  approvalMenunggu: number;
}

function sorotan(s: SaasSnapshot): string[] {
  const out: string[] = [];
  if (!s.health) out.push('Belum ada evaluasi Health Score');
  else {
    const lemah = [...s.health.komponen].filter((k) => k.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2);
    for (const k of lemah) {
      out.push(`${KOMPONEN_LABELS[k.key as keyof typeof KOMPONEN_LABELS] ?? k.key} lemah (${k.score ?? '-'}/100)`);
    }
    if (!s.health.dataCukup) out.push('Data metrik tidak lengkap');
  }
  if (s.mrr !== null) out.push(`MRR ${s.mrr}`);
  if (s.mrr !== null) out.push(`MRR tercatat ${s.mrr}`);
  if (s.kontenTerbit > 0) out.push(`${s.kontenTerbit} konten terbit`);
  if (s.approvalMenunggu > 0) out.push(`${s.approvalMenunggu} persetujuan menunggu`);
  return out.slice(0, 6);
}

function rekomendasiAturan(s: SaasSnapshot): z.infer<typeof Rekomendasi>[] {
  const out: z.infer<typeof Rekomendasi>[] = [];
  if (s.approvalMenunggu > 0) {
    out.push({ saas_id: s.id, prioritas: 'tinggi', rekomendasi: `Tinjau ${s.approvalMenunggu} persetujuan yang menunggu`, dasar: 'Tindakan agen tertahan hingga diputuskan' });
  }
  if (s.health && s.health.skor < 70) {
    out.push({ saas_id: s.id, prioritas: 'tinggi', rekomendasi: 'Susun analisis penyebab penurunan skor', dasar: `Health Score ${s.health.skor}` });
  }
  if (s.rating !== null && s.rating < 4) {
    out.push({ saas_id: s.id, prioritas: 'sedang', rekomendasi: 'Prioritaskan perbaikan bug dari ulasan negatif', dasar: `Rating ${round(s.rating, 2)}` });
  }
  if (s.prTerbuka > 0) {
    out.push({ saas_id: s.id, prioritas: 'sedang', rekomendasi: `Tinjau ${s.prTerbuka} PR dari agen Engineering`, dasar: 'Merge menunggu persetujuan manusia' });
  }
  return out;
}

export async function jalankanParent(
  rt: AgentRuntime,
  opts: { periode: 'harian' | 'mingguan'; snapshots: SaasSnapshot[]; konten?: Array<{ saas_id: string; kanal: ContentKanal; judul: string }> },
): Promise<AgentOutcome<KeluaranParent>> {
  const data = opts.snapshots.map((s) => ({
    id: s.id,
    nama: s.nama,
    status: s.status,
    skor: s.health?.skor ?? null,
    dataCukup: s.health?.dataCukup ?? false,
    komponen: s.health?.komponen.map((k) => ({ key: k.key, skor: k.score })) ?? [],
    mrr: s.mrr,
    signup: s.signup,
    rating: s.rating,
    pr_terbuka: s.prTerbuka,
    approval_menunggu: s.approvalMenunggu,
  }));

  const loop = await runAgentLoop({
    sistem: `Kamu Agen Induk untuk portofolio SaaS. Susun ringkasan ${opts.periode} yang jujur berdasarkan data, dan rekomendasi tindakan yang spesifik. Kamu tidak mengubah status sendiri; usulan status menunggu Health engine dan persetujuan pemilik.`,
    tugas: `Data portofolio:\n${bungkusDataLuar('portofolio', JSON.stringify(data))}`,
    tools: [],
    tier: tierUntuk('analisis_penyebab'),
    skemaKeluaran: KeluaranParent,
    maxLangkah: Math.min(rt.batasLangkah, 3),
    maxToken: 16_000,
    budget: { sisaUsd: rt.sisaAnggaranUsd },
    jalankanTool: async () => ({ observasi: 'tidak ada tool' }),
    model: rt.model,
    logger: rt.logger,
    now: () => rt.now,
    fallback: () => {
      const ringkasanPer = opts.snapshots.map((s) => ({
        saas_id: s.id,
        nama: s.nama,
        skor: s.health?.skor ?? 0,
        status: s.status,
        sorotan: sorotan(s),
      }));
      const rekomendasi = opts.snapshots.flatMap(rekomendasiAturan);
      const rata = round(opts.snapshots.reduce((a, s) => a + (s.health?.skor ?? 0), 0) / Math.max(1, opts.snapshots.length), 1);
      const perluPerhatian = opts.snapshots.filter((s) => (s.health?.skor ?? 0) < 70).map((s) => s.nama);
      return {
        tool: null,
        argumen: {},
        keluaran: {
          periode: opts.periode,
          ringkasan_portofolio: `Portofolio ${opts.snapshots.length} SaaS Unit dengan rata-rata Health Score ${rata}. ${perluPerhatian.length > 0 ? `Perlu perhatian: ${perluPerhatian.join(', ')}.` : 'Semua SaaS Unit dalam batas kesehatan.'} ${rekomendasi.length} rekomendasi tindakan.`,
          ringkasan_per_saas: ringkasanPer,
          rekomendasi,
          usulan_status: [],
        },
      };
    },
  });

  return {
    hasil: loop.keluaran,
    ringkasanMemori: `Parent ${opts.periode}: ${opts.snapshots.length} SaaS Unit, ${loop.keluaran.rekomendasi.length} rekomendasi.`,
    biayaUsd: loop.biayaUsd,
    tokenMasuk: loop.tokenMasuk,
    tokenKeluar: loop.tokenKeluar,
    model: loop.model,
    langkah: loop.langkah,
    ditahan: loop.ditahan,
  };
}
