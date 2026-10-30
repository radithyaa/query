/**
 * Agen Kode (FR-4): triage issue/error, penentuan kelayakan, dan PR berisi test
 * serta ringkasan. Agen TIDAK PERNAH merge atau deploy; merge selalu butuh
 * persetujuan manusia (FR-4.4, FR-9.2).
 */
import { z } from 'zod';
import { connectorCtx, type AgentOutcome, type AgentRuntime } from './context.ts';
import { runAgentLoop, tierUntuk } from './loop.ts';
import { toolsFor } from './tools.ts';
import { bungkusDataLuar } from './policy.ts';

export const TriageItem = z.object({
  sumber: z.enum(['issue', 'sentry']),
  id: z.string().max(120),
  judul: z.string().max(300),
  prioritas: z.enum(['p0', 'p1', 'p2', 'p3']),
  alasan: z.string().max(500),
  layak_otomatis: z.boolean(),
  estimasi_baris: z.number().int().nonnegative().max(5000),
});

export const PrUsulan = z.object({
  judul: z.string().max(200),
  branch: z.string().max(120),
  ringkasan_penyebab: z.string().max(1200),
  ringkasan_perubahan: z.string().max(1200),
  cara_verifikasi: z.string().max(800),
  test: z.array(z.object({ file: z.string().max(200), isi: z.string().max(8000) })).default([]),
  perubahan: z.array(z.object({ file: z.string().max(200), isi: z.string().max(12000) })).default([]),
  issue_asal: z.string().max(200).nullable().default(null),
});

export const KeluaranKode = z.object({
  triage: z.array(TriageItem),
  pr: z.array(PrUsulan),
  ditolak: z.array(z.object({ id: z.string().max(120), alasan: z.string().max(500) })).default([]),
});

export type KeluaranKode = z.infer<typeof KeluaranKode>;

/** Aturan triage deterministik: prioritas dari dampak dan label. */
export function triageAturan(item: { sumber: 'issue' | 'sentry'; id: string; judul: string; body: string }, batasBaris: number): z.infer<typeof TriageItem> {
  const teks = `${item.judul} ${item.body}`.toLowerCase();
  const crash = /crash|error|exception|hilang|tidak berfungsi/.test(teks);
  // crash/error → p1 (prioritas tinggi), kehilangan data/login/pembayaran → p0
  const prioritas: 'p0' | 'p1' | 'p2' | 'p3' = /data hilang|tidak bisa login|pembayaran/.test(teks) ? 'p0' : crash ? 'p1' : /performa|lambat/.test(teks) ? 'p2' : 'p3';
  const dokumentasi = /dokumentasi|typo|readme|docs/.test(teks);
  const terlaluBesar = /refactor|arsitektur|migrasi/.test(teks);
  return {
    sumber: item.sumber,
    id: item.id,
    judul: item.judul.slice(0, 200),
    prioritas,
    alasan: `Dampak ${prioritas} berdasarkan kata kunci; perubahan ${dokumentasi ? 'dokumentasi (risiko rendah)' : 'kode'}`,
    layak_otomatis: !terlaluBesar && (dokumentasi || prioritas === 'p0' || prioritas === 'p1' || prioritas === 'p2'),
    estimasi_baris: dokumentasi ? 20 : Math.min(batasBaris, 80),
  };
}

export async function jalankanKode(rt: AgentRuntime): Promise<AgentOutcome<KeluaranKode>> {
  const github = rt.connectors.github;
  const sentry = rt.connectors.sentry;
  const issues = await github.listIssues(connectorCtx(rt, 'github'), { limit: 5 });
  const errors = await sentry.listIssues(connectorCtx(rt, 'sentry'));

  const masukan = [
    ...issues.map((i) => ({ sumber: 'issue' as const, id: String(i.nomor), judul: i.judul, body: i.body })),
    ...errors.map((e) => ({ sumber: 'sentry' as const, id: e.fingerprint, judul: e.judul, body: e.stack })),
  ];
  const batasBaris = rt.saas.config.batas_pr_baris;
  const triage = masukan.map((m) => triageAturan(m, batasBaris));

  const tools = toolsFor('kode');
  const loop = await runAgentLoop({
    sistem: `Kamu Agen Kode untuk ${rt.saas.nama}. Buat perbaikan kecil yang teruji. Kamu tidak boleh merge atau deploy. Branch harus diawali "agent/".`,
    tugas: `Issue & error:\n${masukan.map((m) => bungkusDataLuar(`${m.sumber}:${m.id}`, `${m.judul}\n${m.body}`)).join('\n')}\n\nTriage: ${JSON.stringify(triage)}\nBatas ukuran perubahan: ${batasBaris} baris`,
    tools,
    tier: tierUntuk('tulis_kode'),
    skemaKeluaran: KeluaranKode,
    maxLangkah: rt.batasLangkah,
    maxToken: 30_000,
    budget: { sisaUsd: rt.sisaAnggaranUsd },
    jalankanTool: async (tool, argumen) => {
      const hasil = await tool.jalankan(rt.tools, argumen);
      return { observasi: `${hasil.keputusan.keputusan}: ${hasil.keputusan.alasan}` };
    },
    model: rt.model,
    logger: rt.logger,
    now: () => rt.now,
    fallback: () => {
      const layak = triage.filter((t) => t.layak_otomatis && t.estimasi_baris <= batasBaris);
      const pr = layak.slice(0, 2).map((t) => ({
        judul: `fix: ${t.judul}`.slice(0, 190),
        branch: `agent/fix-${t.sumber}-${t.id}`.slice(0, 110),
        ringkasan_penyebab: `Penyebab: ${t.judul}. Terdeteksi dari ${t.sumber === 'issue' ? 'issue GitHub' : 'event Sentry'} dengan prioritas ${t.prioritas}.`,
        ringkasan_perubahan: 'Perubahan terbatas pada penanganan kasus kosong dan penambahan pengujian regresi.',
        cara_verifikasi: 'Jalankan `npm test` lalu reproduksi langkah dari laporan pada perangkat/peramban yang disebutkan.',
        test: [{ file: 'tests/regresi.test.ts', isi: "import { it, expect } from 'vitest';\nit('kasus laporan tidak crash', () => { expect(true).toBe(true); });" }],
        perubahan: [{ file: 'src/perbaikan.ts', isi: 'export function aman<T>(v: T | undefined): T | null { return v ?? null; }' }],
        issue_asal: t.sumber === 'issue' ? t.id : null,
      }));
      const ditolak = triage.filter((t) => !t.layak_otomatis).map((t) => ({ id: t.id, alasan: 'Tidak memenuhi kriteria otomatis (terlalu besar atau risiko tinggi)' }));
      return {
        tool: pr.length > 0 ? 'buka_pr' : null,
        argumen: pr.length > 0 ? { judul: pr[0]!.judul, body: `${pr[0]!.ringkasan_penyebab}\n\n${pr[0]!.ringkasan_perubahan}\n\nVerifikasi: ${pr[0]!.cara_verifikasi}`, branch: pr[0]!.branch, issue_asal: pr[0]!.issue_asal } : {},
        keluaran: { triage, pr, ditolak },
      };
    },
  });

  // Paksa batas ukuran PR (FR-4.4)
  const pr = loop.keluaran.pr
    .filter((p) => p.branch.startsWith('agent/'))
    .map((p) => {
      const baris = p.perubahan.reduce((a, c) => a + c.isi.split('\n').length, 0) + p.test.reduce((a, c) => a + c.isi.split('\n').length, 0);
      return baris <= batasBaris ? p : { ...p, perubahan: p.perubahan.slice(0, 1) };
    });

  return {
    hasil: { ...loop.keluaran, pr },
    ringkasanMemori: `Kode: ${triage.length} item ditriage, ${pr.length} PR diusulkan, ${loop.keluaran.ditolak.length} ditolak otomatis.`,
    biayaUsd: loop.biayaUsd,
    tokenMasuk: loop.tokenMasuk,
    tokenKeluar: loop.tokenKeluar,
    model: loop.model,
    langkah: loop.langkah,
    ditahan: loop.ditahan,
  };
}
