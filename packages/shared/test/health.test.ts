import { describe, expect, it } from 'vitest';
import { DailyMetric } from '../src/schemas.ts';
import { computeHealth, decideTransition, evaluateResurrection, normalize } from '../src/health-core.ts';
import { addDays, redactPii, isoWeek } from '../src/util.ts';
import type { DailyMetric as Metric } from '../src/schemas.ts';

function series(days: number, fn: (i: number) => Partial<Metric>): Metric[] {
  return Array.from({ length: days }, (_, i) => ({
    skema_versi: 1 as const,
    tanggal: addDays('2026-09-01', i),
    mata_uang: 'USD',
    ...fn(i),
  })) as Metric[];
}

const sehat = (i: number) => ({
  bisnis: { mrr: 1000 + i * 20, pelanggan_aktif: 100, signup_baru: 5, churn_bulanan_persen: 2 },
  produk: { dau: 100, mau: 900, aktivasi_persen: 40 },
  toko_aplikasi: { rating_rata2: 4.5, ulasan_baru: 4, ulasan_negatif: 0 },
  stabilitas: { error_rate_persen: 0.2, uptime_persen: 99.95, bug_terbuka: 3 },
  biaya: { infra: 30, agen: 10 },
});

const sakit = (i: number) => ({
  bisnis: { mrr: 1000 - i * 25, pelanggan_aktif: 20, signup_baru: 0, churn_bulanan_persen: 9 },
  produk: { dau: 10, mau: 200, aktivasi_persen: 5 },
  toko_aplikasi: { rating_rata2: 3.0, ulasan_baru: 10, ulasan_negatif: 7 },
  stabilitas: { error_rate_persen: 6, uptime_persen: 97.5, bug_terbuka: 40 },
  biaya: { infra: 400, agen: 200 },
});

describe('skema metrik harian §6.2', () => {
  it('menerima contoh dari SRS', () => {
    const parsed = DailyMetric.parse({
      skema_versi: 1,
      tanggal: '2026-10-29',
      mata_uang: 'IDR',
      bisnis: { mrr: 4500000, pelanggan_aktif: 120, signup_baru: 14, churn_bulanan_persen: 3.2 },
      produk: { dau: 310, mau: 980, aktivasi_persen: 41.5 },
      toko_aplikasi: { rating_rata2: 4.1, ulasan_baru: 6, ulasan_negatif: 2 },
      stabilitas: { error_rate_persen: 0.4, uptime_persen: 99.8, bug_terbuka: 7 },
      biaya: { infra: 650000, agen: 420000 },
    });
    expect(parsed.bisnis?.mrr).toBe(4500000);
  });

  it('menerima null untuk metrik yang belum tersedia', () => {
    const parsed = DailyMetric.parse({ skema_versi: 1, tanggal: '2026-10-29', bisnis: { mrr: null, pelanggan_aktif: null, signup_baru: null, churn_bulanan_persen: null } });
    expect(parsed.bisnis?.mrr).toBeNull();
  });

  it('menolak versi skema dan tanggal yang tidak valid', () => {
    expect(() => DailyMetric.parse({ skema_versi: 2, tanggal: '2026-10-29' })).toThrow();
    expect(() => DailyMetric.parse({ skema_versi: 1, tanggal: '29-10-2026' })).toThrow();
    expect(() => DailyMetric.parse({ skema_versi: 1, tanggal: '2026-10-29', produk: { mau: -1 } })).toThrow();
  });
});

describe('Health Score', () => {
  it('normalisasi mengikuti rumus min/target', () => {
    expect(normalize(15, { min: -10, target: 15 })).toBe(100);
    expect(normalize(-10, { min: -10, target: 15 })).toBe(0);
    expect(normalize(2.5, { min: -10, target: 15 })).toBeCloseTo(50, 5);
    expect(normalize(2, { min: 10, target: 2 }, true)).toBe(100);
    expect(normalize(10, { min: 10, target: 2 }, true)).toBe(0);
  });

  it('SaaS yang sehat mendapat skor tinggi dan semua komponen tersedia', () => {
    const result = computeHealth({ metrics: series(28, sehat) });
    expect(result.dataCukup).toBe(true);
    expect(result.bobotHilang).toBe(0);
    expect(result.skor).toBeGreaterThan(70);
    expect(result.komponen.filter((k) => k.score !== null)).toHaveLength(6);
  });

  it('SaaS yang sakit mendapat skor rendah', () => {
    const result = computeHealth({ metrics: series(28, sakit) });
    expect(result.skor).toBeLessThan(30);
  });

  it('metrik yang hilang dinormalkan ulang', () => {
    const tanpaBisnis = series(28, (i) => {
      const m = sehat(i);
      return { ...m, bisnis: null, biaya: null };
    });
    const result = computeHealth({ metrics: tanpaBisnis });
    // pendapatan(25) + retensi(20) + biaya(10) hilang; pengguna kini dihitung dari aktivasi
    expect(result.bobotHilang).toBe(55);
    expect(result.dataCukup).toBe(false);
    expect(result.alasan.join(' ')).toContain('tidak cukup');
  });

  it('bobot dapat diubah dan dinormalisasi ke 100', () => {
    const result = computeHealth({
      metrics: series(28, sehat),
      bobot: { pendapatan: 0, retensi: 0, pengguna: 70, kepuasan: 30, stabilitas: 0, biaya: 0 },
    });
    const used = result.komponen.filter((k) => k.weightUsed > 0);
    expect(used.reduce((a, k) => a + k.weightUsed, 0)).toBeCloseTo(100, 1);
    expect(used.map((k) => k.key).sort()).toEqual(['kepuasan', 'pengguna']);
  });

  it('deterministik: perhitungan ulang dari data historis memberi hasil sama', () => {
    const metrics = series(40, sehat);
    const a = computeHealth({ metrics, tanggal: '2026-10-01' });
    const b = computeHealth({ metrics: metrics.slice(0, 30), tanggal: '2026-10-01' });
    expect(a.skor).toBe(b.skor);
  });
});

describe('aturan transisi FR-8', () => {
  const low = computeHealth({ metrics: series(28, sakit) });
  const worse = { ...low, skor: 40 };
  const healthy = computeHealth({ metrics: series(28, sehat) });

  const base = {
    dataCukup: true,
    skor: 60,
    konektorUtamaMatiJam: null,
    kriteriaBangkitTercapai: false,
    tenggatLewat: false,
    pengecualianSunset: false,
    rencanaDisetujui: false,
  } as const;

  it('Aktif → Pengawasan butuh dua evaluasi berturut-turut di bawah 70', () => {
    expect(decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [low] }).type).toBe('tetap');
    const out = decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [low, low] });
    expect(out).toMatchObject({ type: 'turun', ke: 'pengawasan' });
  });

  it('Pengawasan → Intervensi butuh dua evaluasi di bawah 55', () => {
    expect(decideTransition({ ...base, statusSekarang: 'pengawasan', riwayat: [worse, worse] })).toMatchObject({
      type: 'turun',
      ke: 'intervensi',
    });
    const tinggi = { ...low, skor: 60 };
    expect(decideTransition({ ...base, statusSekarang: 'pengawasan', riwayat: [tinggi, tinggi] }).type).toBe('tetap');
  });

  it('data tidak cukup tidak menurunkan status', () => {
    const out = decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [low, low], dataCukup: false });
    expect(out.type).toBe('tetap');
  });

  it('konektor utama mati menahan evaluasi', () => {
    const out = decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [low, low], konektorUtamaMatiJam: 72 });
    expect(out.type).toBe('tetap');
    expect(out.alasan).toContain('ditahan');
  });

  it('Intervensi → Percobaan setelah pemilik menyetujui rencana', () => {
    const out = decideTransition({ ...base, statusSekarang: 'intervensi', riwayat: [low], rencanaDisetujui: true });
    expect(out).toMatchObject({ type: 'naik', ke: 'percobaan' });
  });

  it('Percobaan → Usulan Sunset ketika tenggat lewat', () => {
    const out = decideTransition({ ...base, statusSekarang: 'percobaan', riwayat: [low], tenggatLewat: true });
    expect(out).toMatchObject({ type: 'turun', ke: 'usulan_sunset' });
  });

  it('Usulan Sunset tidak berpindah otomatis (tidak otonom)', () => {
    const out = decideTransition({ ...base, statusSekarang: 'usulan_sunset', riwayat: [healthy], kriteriaBangkitTercapai: true });
    expect(out.type).toBe('tetap');
  });

  it('pemulihan ke Aktif dari status mana pun', () => {
    for (const status of ['pengawasan', 'intervensi', 'percobaan'] as const) {
      const out = decideTransition({ ...base, statusSekarang: status, riwayat: [healthy], kriteriaBangkitTercapai: true });
      expect(out).toMatchObject({ type: 'naik', ke: 'aktif' });
    }
  });

  it('ambang dapat diubah lewat konfigurasi', () => {
    const bawah40 = decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [low, low], ambang: { pengawasan: 1 } });
    expect(bawah40.type).toBe('tetap');
    const bawah90 = decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [healthy, healthy], ambang: { pengawasan: 90 } });
    expect(bawah90).toMatchObject({ type: 'turun', ke: 'pengawasan' });
  });

  it('data tidak cukup pada riwayat tidak dihitung untuk penurunan', () => {
    const tidakCukup = { ...low, dataCukup: false };
    const out = decideTransition({ ...base, statusSekarang: 'aktif', riwayat: [tidakCukup, tidakCukup] });
    expect(out.type).toBe('tetap');
  });
});

describe('kriteria bangkit', () => {
  it('tercapai bila semua syarat terpenuhi', () => {
    const metrics = series(28, (i) => ({ ...sehat(i), bisnis: { ...sehat(i).bisnis, mrr: 1000 + i * 10 } }));
    const out = evaluateResurrection(
      { jendela_evaluasi_hari: 28, masa_percobaan_hari: 90, syarat: [{ metrik: 'pertumbuhan_mrr_persen', minimal: 10 }, { metrik: 'rating_rata2', minimal: 4.0 }] },
      metrics,
    );
    expect(out.tercapai).toBe(true);
  });

  it('tidak tercapai bila satu syarat gagal', () => {
    const metrics = series(28, sakit);
    const out = evaluateResurrection(
      { jendela_evaluasi_hari: 28, masa_percobaan_hari: 90, syarat: [{ metrik: 'rating_rata2', minimal: 4.0 }] },
      metrics,
    );
    expect(out.tercapai).toBe(false);
    expect(out.detail[0]!.lulus).toBe(false);
  });
});

describe('utilitas', () => {
  it('meredaksi PII', () => {
    const red = redactPii('hubungi budi@contoh.id atau 081234567890, kartu 4111 1111 1111 1111');
    expect(red).toBe('hubungi [email] atau [telepon], kartu [kartu]');
  });

  it('menghitung minggu ISO', () => {
    expect(isoWeek(Date.parse('2026-10-29T00:00:00Z'))).toBe('2026-W44');
  });
});
