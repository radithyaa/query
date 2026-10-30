/**
 * Seed data contoh: tiga SaaS Unit dengan konfigurasi berbeda (§11.1) dan
 * metrik 45 hari agar Health Score, transisi status, dan dashboard punya isi.
 *
 * Skenario disengaja dibuat berbeda: satu unit sehat, satu menurun ke
 * pengawasan, dan satu dalam intervensi — sehingga alur FR-8 dapat dicoba
 * tanpa data produksi. Idempoten: jika sudah ada SaaS Unit, seed dilewati.
 */
import { addDays, isoDate, randomId, type DailyMetric, type SaasStatus } from '@portfolio/shared';
import { bukaAplikasi } from './lib.ts';

interface UnitSeed {
  slug: string;
  nama: string;
  status: SaasStatus;
  platform: string[];
  repo: string;
  otonomi: Record<string, 'draf' | 'persetujuan' | 'otonom'>;
  anggaran: Record<string, number>;
  /** faktor pertumbuhan MRR harian */
  tren: number;
  mrrAwal: number;
  ratingAwal: number;
  ratingAkhir: number;
  kriteria: Array<{ metrik: 'pertumbuhan_mrr_persen' | 'rating_rata2' | 'churn_bulanan_persen'; minimal?: number; maksimal?: number }>;
}

const UNITS: UnitSeed[] = [
  {
    slug: 'laporanku',
    nama: 'LaporanKu',
    status: 'aktif',
    platform: ['android', 'web'],
    repo: 'org/laporanku',
    otonomi: { promosi: 'persetujuan', review: 'otonom', kode: 'persetujuan', support: 'draf' },
    anggaran: { promosi: 40, review: 15, kode: 60, support: 10, token: 20 },
    tren: 0.4,
    mrrAwal: 3_600_000,
    ratingAwal: 4.0,
    ratingAkhir: 4.6,
    kriteria: [
      { metrik: 'pertumbuhan_mrr_persen', minimal: 5 },
      { metrik: 'rating_rata2', minimal: 4.2 },
    ],
  },
  {
    slug: 'kasirku',
    nama: 'KasirKu',
    status: 'pengawasan',
    platform: ['android'],
    repo: 'org/kasirku',
    otonomi: { promosi: 'draf', review: 'draf', kode: 'draf', support: 'draf' },
    anggaran: { promosi: 20, review: 10, kode: 30, support: 8, token: 10 },
    tren: -0.6,
    mrrAwal: 5_200_000,
    ratingAwal: 4.3,
    ratingAkhir: 3.2,
    kriteria: [
      { metrik: 'pertumbuhan_mrr_persen', minimal: 10 },
      { metrik: 'rating_rata2', minimal: 4.0 },
    ],
  },
  {
    slug: 'notaku',
    nama: 'NotaKu',
    status: 'intervensi',
    platform: ['web'],
    repo: 'org/notaku',
    otonomi: { promosi: 'draf', review: 'draf', kode: 'draf', support: 'draf' },
    anggaran: { promosi: 10, review: 8, kode: 20, support: 5, token: 8 },
    tren: -0.2,
    mrrAwal: 900_000,
    ratingAwal: 3.8,
    ratingAkhir: 3.4,
    kriteria: [{ metrik: 'pertumbuhan_mrr_persen', minimal: 10 }],
  },
];

function metrikUntuk(unit: UnitSeed, tanggal: string, i: number, total: number): DailyMetric {
  const progres = total <= 1 ? 1 : i / (total - 1);
  const mrr = Math.round(unit.mrrAwal * (1 + (unit.tren / 100) * i));
  const rating = Math.round((unit.ratingAwal + (unit.ratingAkhir - unit.ratingAwal) * progres) * 100) / 100;
  const mau = 400 + Math.round(unit.mrrAwal / 20_000) + (unit.tren > 0 ? i * 3 : -i);
  const churn = unit.tren < 0 ? Math.min(12, 3 + Math.abs(unit.tren) * i * 0.4) : 2.2;
  return {
    skema_versi: 1,
    tanggal,
    mata_uang: 'IDR',
    bisnis: { mrr, pelanggan_aktif: Math.max(1, Math.round(mrr / 35_000)), signup_baru: Math.max(0, Math.round(mau * 0.01)), churn_bulanan_persen: Math.round(churn * 10) / 10 },
    produk: { dau: Math.round(mau / 3), mau, aktivasi_persen: unit.tren > 0 ? 42 : 30 },
    toko_aplikasi: { rating_rata2: rating, ulasan_baru: 4 + (i % 3), ulasan_negatif: unit.tren < 0 ? 3 : 1 },
    stabilitas: { error_rate_persen: unit.tren < 0 ? 2.4 : 0.4, uptime_persen: unit.tren < 0 ? 98.9 : 99.8, bug_terbuka: unit.tren < 0 ? 9 : 4 },
    biaya: { infra: 650_000, agen: 120_000 },
  };
}

const now = Date.now();
const app = await bukaAplikasi();
const { repos } = app.ctx;

const sudahAda = await repos.saas.count();
if (sudahAda > 0) {
  console.log(JSON.stringify({ level: 'info', msg: 'seed.dilewati', alasan: `${sudahAda} SaaS Unit sudah ada` }));
} else {
  const hari = 45;
  const mulai = addDays(isoDate(now), -(hari - 1));
  for (const unit of UNITS) {
    const id = randomId();
    await repos.saas.insert({
      id,
      slug: unit.slug,
      nama: unit.nama,
      status: 'aktif',
      config: {
        platform: unit.platform,
        otonomi: unit.otonomi,
        anggaran_bulanan_usd: unit.anggaran,
        kriteria_bangkit: { jendela_evaluasi_hari: 28, masa_percobaan_hari: 90, syarat: unit.kriteria },
        panduan_merek: 'Ramah, ringkas, tanpa klaim berlebihan.',
      },
      dibuatPada: now - hari * 86_400_000,
      repo: unit.repo,
      akunToko: `com.contoh.${unit.slug}`,
      akunSosial: `instagram/${unit.slug}`,
    });
    for (const [jenis, utama] of [['github', false], ['play', true], ['instagram', false], ['sentry', false], ['billing', true], ['analytics', true]] as const) {
      await repos.saas.upsertConnector({ id: randomId(), saasId: id, jenis, secretRef: `secret://${jenis}/${unit.slug}`, detail: {}, utama, terakhirSehat: now });
    }
    for (let i = 0; i < hari; i += 1) {
      const tanggal = addDays(mulai, i);
      await repos.metric.upsert({ saas_id: id, tanggal, skema_versi: 1, metrik: metrikUntuk(unit, tanggal, i, hari), diterima_pada: Date.parse(`${tanggal}T01:00:00Z`) });
    }
    // status dinaikkan/diturunkan oleh Health engine pada siklus pertama; seed hanya menyiapkan data
    await repos.saas.updateStatus(id, unit.status, now - 3 * 86_400_000);
    await repos.audit.append({ aktor: 'sistem', tindakan: 'seed.saas', saasId: id, keluaran: { slug: unit.slug, hari }, waktu: now });
    console.log(JSON.stringify({ level: 'info', msg: 'seed.unit', slug: unit.slug, id, hari }));
  }
}

app.db.close();
