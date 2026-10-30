/**
 * Klien model abstrak. Agen hanya bergantung pada antarmuka ini sehingga
 * penyedia (Anthropic, model lokal, atau mock) dapat diganti tanpa mengubah prompt.
 */
import type { ZodType } from 'zod';

export type ModelTier = 'kecil' | 'menengah' | 'besar';

export interface ModelProfile {
  tier: ModelTier;
  model: string;
  maxToken: number;
}

/**
 * Pemilihan model per tugas (§3.3): klasifikasi/spam → kecil, penulisan konten
 * dan kode → menengah, analisis penyebab/Health → besar.
 */
export const MODEL_TIERS: Record<ModelTier, ModelProfile> = {
  kecil: { tier: 'kecil', model: 'claude-haiku-4-5', maxToken: 1024 },
  menengah: { tier: 'menengah', model: 'claude-sonnet-4-5', maxToken: 4096 },
  besar: { tier: 'besar', model: 'claude-opus-4-1', maxToken: 8192 },
};

export const LANGKAH_MODEL: Record<string, ModelTier> = {
  klasifikasi_ulasan: 'kecil',
  tandai_spam: 'kecil',
  tulis_konten: 'menengah',
  tulis_kode: 'menengah',
  jawab_support: 'menengah',
  ringkasan: 'menengah',
  analisis_penyebab: 'besar',
  usulan_sunset: 'besar',
};

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelUsage {
  tokenMasuk: number;
  tokenKeluar: number;
}

export interface ModelResult {
  text: string;
  usage: ModelUsage;
  /** alasan model untuk keluaran (dipakai NFR/§11.2: keluaran menyertakan alasan) */
  model: string;
}

export interface ModelClient {
  readonly nama: string;
  complete(input: {
    profil: ModelProfile;
    system: string;
    messages: ModelMessage[];
    /** skema keluaran; model diminta mengembalikan JSON sesuai skema */
    skema?: ZodType;
  }): Promise<ModelResult>;
}

/**
 * Mock model deterministik untuk lokal/test: menghasilkan JSON yang valid sesuai
 * skema berdasarkan prompt yang diberikan. Tidak memanggil jaringan.
 */
export class MockModelClient implements ModelClient {
  readonly nama = 'mock';
  private readonly generator: (input: { system: string; messages: ModelMessage[]; skema?: ZodType }) => unknown;

  constructor(generator?: (input: { system: string; messages: ModelMessage[]; skema?: ZodType }) => unknown) {
    this.generator = generator ?? (() => ({}));
  }

  async complete(input: { profil: ModelProfile; system: string; messages: ModelMessage[]; skema?: ZodType }): Promise<ModelResult> {
    const payload = this.generator({ system: input.system, messages: input.messages, skema: input.skema });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      text,
      model: input.profil.model,
      usage: { tokenMasuk: Math.ceil((input.system.length + JSON.stringify(input.messages).length) / 4), tokenKeluar: Math.ceil(text.length / 4) },
    };
  }
}

/** Klien Anthropic lewat API HTTP (Workers tidak punya SDK Node SDK tertentu). */
export class AnthropicClient implements ModelClient {
  readonly nama = 'anthropic';
  private readonly opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string };

  constructor(opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.opts = opts;
  }

  async complete(input: { profil: ModelProfile; system: string; messages: ModelMessage[]; skema?: ZodType }): Promise<ModelResult> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: input.profil.model,
        max_tokens: input.profil.maxToken,
        system: [
          { type: 'text', text: input.system, cache_control: { type: 'ephemeral' } },
          ...(input.skema ? [{ type: 'text', text: `Skema keluaran JSON wajib:\n${JSON.stringify(input.skema.toJSONSchema?.() ?? {})}` }] : []),
        ],
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number }; model: string };
    const text = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return { text, model: data.model, usage: { tokenMasuk: data.usage.input_tokens, tokenKeluar: data.usage.output_tokens } };
  }
}

/** Harga ilustratif per 1 juta token (USD); dikonfigurasi, bukan hard-coded final. */
export const HARGA_TOKEN_USD: Record<ModelTier, { masuk: number; keluar: number }> = {
  kecil: { masuk: 1, keluar: 5 },
  menengah: { masuk: 3, keluar: 15 },
  besar: { masuk: 15, keluar: 75 },
};

export function biayaToken(tier: ModelTier, usage: ModelUsage): number {
  const harga = HARGA_TOKEN_USD[tier];
  return (usage.tokenMasuk * harga.masuk + usage.tokenKeluar * harga.keluar) / 1_000_000;
}
