/**
 * Model pengganti untuk mode lokal/staging: tidak ada panggilan jaringan, tetapi
 * loop agen tetap berjalan nyata — satu langkah menyusun rencana tool yang
 * terlihat di prompt, langkah berikutnya menyatakan selesai. Bila model tidak
 * dapat menyelesaikan skema keluaran, `runAgentLoop` memakai fallback
 * deterministik milik masing-masing agen (aturan kata kunci, KB, kalender).
 *
 * Dengan begitu jalur gateway (dan baris `approval`) ikut teruji di lokal.
 */
import type { ZodType } from 'zod';
import type { ModelClient, ModelMessage, ModelProfile, ModelResult } from './model.ts';

const POLA_RENCANA = /Balas HANYA dengan JSON: \{"pemikiran": string, "tool": string\|null, "argumen": object, "selesai": boolean, "keluaran": object\}/;

export class MockPlanModel implements ModelClient {
  readonly nama = 'mock-plan';

  async complete(input: { profil: ModelProfile; system: string; messages: ModelMessage[]; skema?: ZodType }): Promise<ModelResult> {
    const permintaan = input.messages[0]?.content ?? '';
    const sudahPanggil = input.messages.some((m) => m.role === 'user' && m.content.startsWith('Observasi tool '));
    const tool = daftarTool(permintaan);

    let payload: unknown;
    if (!POLA_RENCANA.test(permintaan)) {
      payload = {};
    } else if (!sudahPanggil && tool) {
      payload = { pemikiran: `Langkah 1: menyiapkan ${tool.nama}.`, tool: tool.nama, argumen: tool.argumen, selesai: false };
    } else {
      payload = { pemikiran: 'Menyelesaikan tugas.', tool: null, argumen: {}, selesai: true, keluaran: {} };
    }

    const text = JSON.stringify(payload);
    return {
      text,
      model: input.profil.model,
      usage: { tokenMasuk: Math.ceil((input.system.length + permintaan.length) / 4), tokenKeluar: Math.ceil(text.length / 4) },
    };
  }
}

interface RencanaTool {
  nama: string;
  argumen: Record<string, unknown>;
}

/** Pilih tool aman pertama yang tersedia untuk fungsi ini, dengan argumen contoh. */
function daftarTool(permintaan: string): RencanaTool | null {
  const tersedia = new Set([...permintaan.matchAll(/^- ([a-z_]+) \{/gm)].map((m) => m[1]!));
  if (tersedia.has('simpan_konten')) {
    const judul = /"judul":"([^"]{1,120})"/.exec(permintaan)?.[1];
    return {
      nama: 'simpan_konten',
      argumen: { kanal: 'instagram', judul: judul ?? 'Draf konten', body: 'Draf konten yang menunggu persetujuan pemilik.' },
    };
  }
  if (tersedia.has('buat_issue')) {
    return { nama: 'buat_issue', argumen: { judul: '[Bug] Crash dari ulasan Play Store', body: 'Tema bug terverifikasi dari ulasan pengguna.', labels: ['bug', 'dari-ulasan'] } };
  }
  if (tersedia.has('buka_pr')) {
    return { nama: 'buka_pr', argumen: { judul: 'fix: perbaikan laporan', body: 'Penyebab, perubahan, dan cara verifikasi ada di ringkasan.', branch: 'agent/fix-review', issue_asal: null } };
  }
  if (tersedia.has('balas_ulasan')) {
    return { nama: 'balas_ulasan', argumen: { review_id: 'contoh-ulasan', teks: 'Terima kasih atas ulasan Anda.' } };
  }
  return null;
}
