/**
 * Loop agent generik (§3.3 poin 3): stateless per run, konteks dari konfigurasi,
 * memori kerja, dan data tool. Batas langkah, token, dan waktu dihormati, dan
 * keluaran divalidasi dengan skema Zod.
 *
 * Model diminta menghasilkan rencana tool dalam JSON, lalu loop menjalankan
 * pasangan tool lewat policy gateway hingga model menyatakan `selesai` atau batas
 * tercapai.
 */
import { z, type ZodType } from 'zod';
import { biayaToken, LANGKAH_MODEL, MODEL_TIERS, type ModelMessage, type ModelResult, type ModelTier } from './model.ts';
import { KEBIJAKAN_AGEN, bungkusDataLuar, extractJson } from './policy.ts';
import type { ToolSpec } from './tools.ts';

export const RencanaLangkah = z.object({
  pemikiran: z.string().max(2000),
  tool: z.string().min(1).max(60).nullable().default(null),
  argumen: z.record(z.string(), z.unknown()).default({}),
  selesai: z.boolean().default(false),
  keluaran: z.unknown().optional(),
});

export type RencanaLangkah = z.infer<typeof RencanaLangkah>;

export interface LoopOptions<T> {
  sistem: string;
  tugas: string;
  tools: ToolSpec[];
  tier: ModelTier;
  skemaKeluaran: ZodType<T>;
  maxLangkah: number;
  maxToken: number;
  budget: { sisaUsd: number | null };
  /** jalankan satu tool; kembalikan observasi untuk model */
  jalankanTool: (tool: ToolSpec, argumen: Record<string, unknown>) => Promise<{ observasi: string; terlarang?: boolean }>;
  model: { complete(input: { profil: (typeof MODEL_TIERS)[ModelTier]; system: string; messages: ModelMessage[]; skema?: ZodType }): Promise<ModelResult> };
  /** bila model gagal menghasilkan JSON valid, gunakan fallback deterministik */
  fallback?: () => { tool: string | null; argumen: Record<string, unknown>; keluaran: T };
  logger: (pesan: string, data?: Record<string, unknown>) => void;
  now: () => number;
  waktuMaksMs?: number;
}

export interface LoopResult<T> {
  keluaran: T;
  tokenMasuk: number;
  tokenKeluar: number;
  biayaUsd: number;
  model: string;
  langkah: number;
  ditahan: boolean;
  observasi: string[];
  jejak: Array<{ langkah: number; tool: string | null; keputusan: string; pemikiran: string }>;
}

const ATURAN_TOOL = `Balas HANYA dengan JSON: {"pemikiran": string, "tool": string|null, "argumen": object, "selesai": boolean, "keluaran": object}
Panggil satu tool per langkah. Set "selesai": true dan isi "keluaran" saat tugas tuntas atau tidak ada tool yang tepat.`;

export function daftarToolPrompt(tools: ToolSpec[]): string {
  if (tools.length === 0) return 'Tidak ada tool tulis yang tersedia untuk fungsi ini.';
  return tools
    .map((t) => `- ${t.nama} { ${Object.entries(t.skemaParameter).map(([k, v]) => `${k}: ${v}`).join(', ')} } :: ${t.deskripsi}`)
    .join('\n');
}

export async function runAgentLoop<T>(opts: LoopOptions<T>): Promise<LoopResult<T>> {
  const profil = MODEL_TIERS[opts.tier];
  const deadline = opts.now() + (opts.waktuMaksMs ?? 120_000);
  const observasi: string[] = [];
  const jejak: LoopResult<T>['jejak'] = [];
  let tokenMasuk = 0;
  let tokenKeluar = 0;
  let biayaUsd = 0;
  let modelName = profil.model;
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: `${bungkusDataLuar('tugas_ringkas', opts.tugas)}\n\nTool yang diizinkan:\n${daftarToolPrompt(opts.tools)}\n\n${ATURAN_TOOL}`,
    },
  ];
  const sistem = `${opts.sistem}\n\n${KEBIJAKAN_AGEN}`;
  let langkah = 0;

  const gunakanFallback = (alasan: string): T => {
    if (!opts.fallback) throw new Error(alasan);
    opts.logger('agent.fallback', { alasan });
    const fb = opts.fallback();
    if (fb.tool) {
      const tool = opts.tools.find((t) => t.nama === fb.tool);
      if (tool) void opts.jalankanTool(tool, fb.argumen).catch(() => undefined);
    }
    return fb.keluaran;
  };

  while (langkah < opts.maxLangkah) {
    if (opts.now() > deadline) {
      opts.logger('agent.waktu_habis', { langkah });
      break;
    }
    if (opts.budget.sisaUsd !== null && opts.budget.sisaUsd <= 0) {
      opts.logger('agent.anggaran_habis', { biayaUsd });
      break;
    }
    langkah += 1;

    let result: ModelResult;
    try {
      result = await opts.model.complete({ profil, system: sistem, messages, skema: opts.skemaKeluaran });
    } catch (error) {
      opts.logger('agent.model_error', { pesan: error instanceof Error ? error.message : String(error) });
      return { keluaran: gunakanFallback('model gagal'), tokenMasuk, tokenKeluar, biayaUsd, model: modelName, langkah, ditahan: false, observasi, jejak };
    }
    modelName = result.model || profil.model;
    tokenMasuk += result.usage.tokenMasuk;
    tokenKeluar += result.usage.tokenKeluar;
    biayaUsd += biayaToken(opts.tier, result.usage);
    if (tokenMasuk + tokenKeluar > opts.maxToken) {
      opts.logger('agent.token_habis', { tokenMasuk, tokenKeluar });
      break;
    }

    let rencana: RencanaLangkah;
    try {
      const parsed = RencanaLangkah.safeParse(extractJson(result.text));
      if (!parsed.success) throw new Error('rencana tidak valid');
      rencana = parsed.data;
    } catch {
      opts.logger('agent.keluaran_tidak_valid', { langkah, contoh: result.text.slice(0, 200) });
      messages.push({ role: 'assistant', content: result.text.slice(0, 2000) });
      messages.push({ role: 'user', content: 'Keluaran tidak valid. Balas dengan JSON tunggal sesuai aturan.' });
      continue;
    }

    messages.push({ role: 'assistant', content: JSON.stringify({ pemikiran: rencana.pemikiran.slice(0, 400), tool: rencana.tool, selesai: rencana.selesai }) });

    if (rencana.selesai || !rencana.tool) {
      const keluaran = opts.skemaKeluaran.safeParse(rencana.keluaran);
      if (keluaran.success) {
        jejak.push({ langkah, tool: null, keputusan: 'selesai', pemikiran: rencana.pemikiran.slice(0, 200) });
        return { keluaran: keluaran.data, tokenMasuk, tokenKeluar, biayaUsd, model: modelName, langkah, ditahan: false, observasi, jejak };
      }
      opts.logger('agent.skema_keluaran_tidak_valid', { langkah });
      messages.push({ role: 'user', content: 'Objek "keluaran" tidak sesuai skema. Perbaiki dan set selesai=true.' });
      continue;
    }

    const tool = opts.tools.find((t) => t.nama === rencana.tool);
    if (!tool) {
      // tool tidak ada dalam daftar fungsi ini = percobaan keluar izin
      jejak.push({ langkah, tool: rencana.tool, keputusan: 'tool_tidak_diizinkan', pemikiran: rencana.pemikiran.slice(0, 200) });
      opts.logger('agent.tool_tidak_diizinkan', { tool: rencana.tool });
      observasi.push(`tool ${rencana.tool} tidak diizinkan untuk fungsi ini`);
      messages.push({ role: 'user', content: `Tool "${rencana.tool}" tidak diizinkan untuk fungsi ini. Hanya gunakan: ${opts.tools.map((t) => t.nama).join(', ')}.` });
      continue;
    }

    const hasil = await opts.jalankanTool(tool, rencana.argumen);
    jejak.push({ langkah, tool: tool.nama, keputusan: hasil.observasi.slice(0, 200), pemikiran: rencana.pemikiran.slice(0, 200) });
    observasi.push(hasil.observasi);
    messages.push({ role: 'user', content: `Observasi tool ${tool.nama}: ${hasil.observasi}` });

    if (hasil.terlarang) {
      // permintaan mengarahkan tool di luar izin; hentikan rantai tulis
      opts.logger('agent.terlarang', { tool: tool.nama });
    }
  }

  return {
    keluaran: gunakanFallback('batas langkah tercapai'),
    tokenMasuk,
    tokenKeluar,
    biayaUsd,
    model: modelName,
    langkah,
    ditahan: true,
    observasi,
    jejak,
  };
}

/** Helper tier dari nama langkah; default menengah. */
export function tierUntuk(langkah: string): ModelTier {
  return LANGKAH_MODEL[langkah] ?? 'menengah';
}
