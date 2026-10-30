/**
 * Test tabel keputusan policy gateway (§5.8): tingkat otonomi × jenis tindakan ×
 * status anggaran × kill switch × status SaaS × matriks izin. Harus deterministik.
 */
import { describe, expect, it } from 'vitest';
import { SELALU_HITL, TINDAKAN, type Fungsi, type GatewayCheckRequest } from '@portfolio/shared';
import { decideGateway, tabelKonsisten, type GatewayContext } from '../../../apps/api/src/services/gateway-core.ts';

const BASE_CTX: GatewayContext = {
  saas: {
    id: 's1',
    status: 'aktif',
    paused: false,
    otonomi: {},
    anggaranTerpakaiPersen: 10,
    sisaAnggaranUsd: 50,
    batasAnggaranFungsiUsd: 60,
  },
  killGlobal: false,
  killSaas: false,
  killAlasan: null,
  rateTerlampaui: false,
  now: 1_700_000_000_000,
};

function req(over: Partial<GatewayCheckRequest> = {}): GatewayCheckRequest {
  return { saasId: 's1', fungsi: 'review', tindakan: 'balas_ulasan', idemKey: 'idem-key-0001', payload: {}, ...over };
}

function ctx(over: Partial<GatewayContext> = {}, saas: Partial<GatewayContext['saas']> = {}): GatewayContext {
  return { ...BASE_CTX, ...over, saas: { ...BASE_CTX.saas, ...saas } };
}

describe('policy gateway — kill switch', () => {
  it('kill switch global menang atas semua pemeriksaan lain', () => {
    const d = decideGateway(req({ tindakan: 'balas_ulasan' }), ctx({ killGlobal: true, killAlasan: 'insiden' }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('killswitch:global');
    expect(d.alasan).toContain('insiden');
  });

  it('kill switch per SaaS menolak tindakan', () => {
    const d = decideGateway(req(), ctx({ killSaas: true }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('killswitch:saas');
  });
});

describe('policy gateway — status SaaS Unit', () => {
  it.each(['dihentikan', 'diarsipkan'] as const)('status %s menolak semua tindakan', (status) => {
    const d = decideGateway(req(), ctx({}, { status }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain(`status:${status}`);
  });

  it('dalam_sunset hanya mengizinkan tindakan sunset', () => {
    const lainnya = decideGateway(req({ tindakan: 'balas_ulasan' }), ctx({}, { status: 'dalam_sunset' }));
    expect(lainnya.keputusan).toBe('tolak');
    expect(lainnya.aturan).toContain('status:dalam_sunset');
    const sunset = decideGateway(req({ fungsi: 'parent', tindakan: 'sunset' }), ctx({}, { status: 'dalam_sunset' }));
    expect(sunset.keputusan).toBe('perlu_persetujuan');
    expect(sunset.aturan).toContain('hitl:wajib');
  });

  it('usulan_sunset tetap butuh keputusan pemilik', () => {
    const d = decideGateway(req({ tindakan: 'balas_ulasan' }), ctx({}, { status: 'usulan_sunset', otonomi: { review: 'otonom' } }));
    expect(d.keputusan).toBe('izinkan');
    expect(d.aturan).toContain('otonomi:otonom');
  });
});

describe('policy gateway — matriks izin §3.6', () => {
  const matriks: Array<[Fungsi, string, boolean]> = [
    ['review', 'merge_pr', false],
    ['review', 'deploy', false],
    ['review', 'terbit_post', false],
    ['review', 'buat_issue', true],
    ['support', 'buat_issue', false],
    ['promosi', 'terbit_post', true],
    ['promosi', 'merge_pr', false],
    ['kode', 'buka_pr', true],
    ['kode', 'merge_pr', true],
    ['parent', 'sunset', true],
    ['parent', 'buka_pr', false],
  ];

  it.each(matriks)('fungsi %s terhadap %s → diizinkan: %s', (fungsi, tindakan, boleh) => {
    const d = decideGateway(req({ fungsi, tindakan: tindakan as never, idemKey: `idem-${fungsi}-${tindakan}` }), ctx({}, { otonomi: { [fungsi]: 'otonom' } }));
    if (boleh) {
      expect(d.aturan).not.toContain('izin:matriks');
    } else {
      expect(d.keputusan).toBe('tolak');
      expect(d.aturan).toContain('izin:matriks');
    }
  });
});

describe('policy gateway — anggaran', () => {
  it('anggaran habis menolak', () => {
    const d = decideGateway(req(), ctx({}, { sisaAnggaranUsd: 0, anggaranTerpakaiPersen: 100 }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('anggaran:habis');
  });

  it('perkiraan biaya melebihi sisa menolak', () => {
    const d = decideGateway(req({ tindakan: 'jalankan_render', fungsi: 'promosi', biaya_perkiraan_usd: 30 }), ctx({}, { sisaAnggaranUsd: 10 }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('anggaran:biaya');
  });

  it('anggaran terpakai 100% menolak walau sisa masih dihitung', () => {
    const d = decideGateway(req(), ctx({}, { sisaAnggaranUsd: 5, anggaranTerpakaiPersen: 100 }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('anggaran:100');
  });

  it('anggaran tidak dibatasi (null) tidak menghalangi', () => {
    const d = decideGateway(req({ fungsi: 'review' }), ctx({}, { sisaAnggaranUsd: null, anggaranTerpakaiPersen: null, otonomi: { review: 'otonom' } }));
    expect(d.keputusan).toBe('izinkan');
  });
});

describe('policy gateway — HITL wajib & otonomi', () => {
  it.each([...SELALU_HITL])('tindakan %s selalu perlu persetujuan apa pun otonominya', (tindakan) => {
    const fungsi: Fungsi = tindakan === 'sunset' || tindakan === 'ubah_harga' ? 'parent' : tindakan === 'merge_pr' || tindakan === 'deploy' ? 'kode' : 'promosi';
    const d = decideGateway(req({ fungsi, tindakan, idemKey: `idem-hitl-${tindakan}` }), ctx({}, { otonomi: { [fungsi]: 'otonom' } }));
    expect(d.keputusan).toBe('perlu_persetujuan');
    expect(d.aturan).toContain('hitl:wajib');
    expect(d.jenisPersetujuan).toBeTruthy();
    expect(d.kedaluwarsa).toBeGreaterThan(BASE_CTX.now);
  });

  it('tingkat draf selalu perlu persetujuan', () => {
    const d = decideGateway(req(), ctx({}, { otonomi: { review: 'draf' } }));
    expect(d.keputusan).toBe('perlu_persetujuan');
    expect(d.aturan).toContain('otonomi:draf');
  });

  it('tingkat persetujuan menunggu manusia', () => {
    const d = decideGateway(req(), ctx({}, { otonomi: { review: 'persetujuan' } }));
    expect(d.keputusan).toBe('perlu_persetujuan');
    expect(d.aturan).toContain('otonomi:persetujuan');
  });

  it('tingkat otonom mengizinkan tindakan daftar terbatas', () => {
    const d = decideGateway(req({ tindakan: 'balas_ulasan' }), ctx({}, { otonomi: { review: 'otonom' } }));
    expect(d.keputusan).toBe('izinkan');
    expect(d.aturan).toContain('otonomi:otonom');
  });

  it('tingkat otonom menolak tindakan di luar daftar', () => {
    const d = decideGateway(req({ fungsi: 'promosi', tindakan: 'kirim_email_massal' }), ctx({}, { otonomi: { promosi: 'otonom' } }));
    expect(d.keputusan).toBe('perlu_persetujuan');
    expect(d.aturan.some((r) => r === 'hitl:wajib' || r === 'otonomi:batas')).toBe(true);
  });

  it('jeda per SaaS menolak tindakan', () => {
    const d = decideGateway(req(), ctx({}, { paused: true }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('jeda:saas');
  });

  it('rate limit terlampaui menolak', () => {
    const d = decideGateway(req(), ctx({ rateTerlampaui: true }));
    expect(d.keputusan).toBe('tolak');
    expect(d.aturan).toContain('ratelimit');
  });
});

describe('policy gateway — determinisme & konsistensi tabel', () => {
  it('keputusan identik untuk konteks identik', () => {
    const kasus = { req: req({ tindakan: 'terbit_post', fungsi: 'promosi', idemKey: 'idem-det-0001' }), ctx: ctx({}, { otonomi: { promosi: 'persetujuan' } }) };
    const a = decideGateway(kasus.req, kasus.ctx);
    const b = decideGateway(kasus.req, kasus.ctx);
    expect(a).toEqual(b);
  });

  it('seluruh kombinasi tindakan × fungsi × otonomi selalu menghasilkan keputusan sah', () => {
    const fungsi: Fungsi[] = ['promosi', 'review', 'kode', 'support', 'parent'];
    const otonomi = ['draf', 'persetujuan', 'otonom'] as const;
    let n = 0;
    for (const f of fungsi) {
      for (const t of TINDAKAN) {
        for (const o of otonomi) {
          const d = decideGateway(req({ fungsi: f, tindakan: t, idemKey: `idem-matrix-${f}-${t}-${o}-0001` }), ctx({}, { otonomi: { [f]: o } }));
          expect(['izinkan', 'tolak', 'perlu_persetujuan']).toContain(d.keputusan);
          if (d.keputusan !== 'tolak') expect(d.jenisPersetujuan).toBeTruthy();
          n += 1;
        }
      }
    }
    expect(n).toBe(fungsi.length * TINDAKAN.length * otonomi.length);
  });

  it('tidak ada tindakan HITL yang bisa diizinkan otonom', () => {
    expect(tabelKonsisten()).toBe(true);
    for (const t of SELALU_HITL) {
      // merge_pr/deploy hanya untuk kode, sunset/ubah_harga untuk parent, sisanya promosi
      const fungsi: Fungsi = t === 'merge_pr' || t === 'deploy' ? 'kode' : t === 'sunset' || t === 'ubah_harga' ? 'parent' : 'promosi';
      const d = decideGateway(req({ fungsi, tindakan: t, idemKey: `idem-hitl3-${t}-0001` }), ctx({}, { otonomi: { [fungsi]: 'otonom' } }));
      expect(d.keputusan).toBe('perlu_persetujuan');
      expect(d.aturan).toContain('hitl:wajib');
    }
  });
});
