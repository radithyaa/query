/**
 * Keputusan usulan sunset (FR-8.5, FR-7.7) dan kemajuan tahap FR-8.6.
 *
 * Keduanya khusus pemilik. Keputusan sunset memerlukan autentikasi ulang MFA:
 * server menerima klaim `mfa: true` atau token MFA (`mfa_token`); di lingkungan
 * pengembangan, token berawalan `dev-` diterima (lihat `MFA_TERVERIFIKASI`).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Clock } from 'lucide-react';
import { useState } from 'react';
import { api, type SunsetCase } from '../lib/api';
import { pesanGalat, useAuth } from '../lib/auth';
import {
  fmtTanggal,
  fmtWaktu,
  isoTanggal,
  labelTahapSunset,
  tahapSunsetBerikut,
  URUTAN_TAHAP_SUNSET,
} from '../lib/format';
import { Badge, Dialog, Field, Galat, Input, Select, Textarea, Tombol, useToast } from './ui';

type Keputusan = 'setujui' | 'tolak' | 'pengecualian';

const LABEL: Record<Keputusan, string> = {
  setujui: 'Setujui sunset',
  tolak: 'Tolak usulan',
  pengecualian: 'Beri pengecualian',
};

function defaultTenggat(hari = 60): string {
  return isoTanggal(new Date(Date.now() + hari * 86_400_000));
}

export function DialogKeputusanSunset({
  kasus,
  terbuka,
  onTutup,
}: {
  kasus: SunsetCase | null;
  terbuka: boolean;
  onTutup: () => void;
}) {
  const { owner } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [keputusan, setKeputusan] = useState<Keputusan>('setujui');
  const [catatan, setCatatan] = useState('');
  const [mfa, setMfa] = useState('');
  const [tenggat, setTenggat] = useState(defaultTenggat());
  const [konfirmasi, setKonfirmasi] = useState('');
  const [galat, setGalat] = useState<unknown>(null);

  const butuhTenggat = keputusan !== 'setujui';
  const butuhKonfirmasi = keputusan === 'setujui';
  const konfirmasiCocok = !butuhKonfirmasi || konfirmasi.trim().toUpperCase() === 'SETUJUI';
  const mfaSiap = mfa.trim().length >= 4;

  const kirim = useMutation({
    mutationFn: (id: string) =>
      api.putuskanSunset(id, {
        keputusan,
        mfa_token: mfa.trim(),
        ...(catatan.trim() ? { catatan: catatan.trim() } : {}),
        ...(butuhTenggat ? { tenggat_baru: tenggat } : {}),
      }),
    onSuccess: async () => {
      toast.sukses(
        keputusan === 'setujui'
          ? 'Sunset disetujui; unit masuk tahap pengumuman.'
          : keputusan === 'tolak'
            ? 'Usulan ditolak; unit kembali ke intervensi dengan tenggat baru.'
            : 'Pengecualian diberikan; unit kembali ke intervensi.',
      );
      setMfa('');
      setCatatan('');
      setKonfirmasi('');
      setGalat(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sunset'] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
        qc.invalidateQueries({ queryKey: ['unit'] }),
        qc.invalidateQueries({ queryKey: ['summary'] }),
      ]);
      onTutup();
    },
    onError: (error) => setGalat(error),
  });

  if (!kasus) return null;

  const bukti = kasus.paketBukti ?? {};

  return (
    <Dialog
      terbuka={terbuka}
      onTutup={onTutup}
      judul="Keputusan usulan sunset"
      deskripsi="Penghentian final tidak otonom: hanya pemilik dengan MFA yang dapat memutuskan (FR-8.5)."
      lebar="md"
    >
      <div className="grid gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Kasus</dt>
          <dd className="font-mono">{kasus.id.slice(0, 8)}…</dd>
          <dt className="text-muted">Tahap</dt>
          <dd>
            <Badge nada={kasus.keputusan === 'disetujui' ? 'warn' : 'netral'}>{labelTahapSunset(kasus.tahap)}</Badge>
          </dd>
          <dt className="text-muted">Diusulkan</dt>
          <dd>{fmtWaktu(kasus.dibuatPada)}</dd>
          <dt className="text-muted">Keputusan</dt>
          <dd>{kasus.keputusan ?? 'belum ada'}</dd>
        </dl>

        <details className="rounded-md border border-line p-2 text-xs" open>
          <summary className="cursor-pointer font-medium text-fg">Paket bukti</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(bukti, null, 2)}</pre>
        </details>

        {!owner ? (
          <p className="rounded-md border border-warn/40 bg-warn-soft p-2 text-xs text-warn">
            Hanya pemilik yang dapat memutuskan sunset.
          </p>
        ) : null}

        {kasus.keputusan ? (
          <p className="rounded-md bg-surface-2 p-2 text-xs text-muted">
            Kasus ini sudah diputuskan ({kasus.keputusan}) oleh {kasus.diputuskanOleh ?? '—'}. Gunakan &ldquo;Maju tahap&rdquo; untuk melanjutkan FR-8.6.
          </p>
        ) : (
          <>
            <fieldset className="grid gap-2">
              <legend className="text-xs font-medium text-fg">Keputusan</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup">
                {(['setujui', 'tolak', 'pengecualian'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={keputusan === k}
                    onClick={() => setKeputusan(k)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                      keputusan === k
                        ? k === 'setujui'
                          ? 'border-bad bg-bad-soft text-bad'
                          : 'border-warn bg-warn-soft text-warn'
                        : 'border-line text-muted hover:bg-surface-2'
                    }`}
                  >
                    {LABEL[k]}
                  </button>
                ))}
              </div>
            </fieldset>

            {butuhTenggat ? (
              <Field label="Tenggat baru" hint="Dipakai untuk masa percobaan berikutnya bila usulan ditolak/dikecualikan.">
                {(id) => <Input id={id} type="date" value={tenggat} min={isoTanggal(new Date())} onChange={(e) => setTenggat(e.target.value)} />}
              </Field>
            ) : null}

            <Field label="Token MFA / autentikasi ulang" wajib hint="Minimal 4 karakter. Lingkungan lokal menerima token berawalan dev-.">
              {(id) => <Input id={id} type="password" autoComplete="one-time-code" value={mfa} onChange={(e) => setMfa(e.target.value)} />}
            </Field>

            <Field label="Catatan keputusan" hint="Tersimpan di audit beserta aktor dan waktu (FR-8.8).">
              {(id) => <Textarea id={id} maxLength={2000} value={catatan} onChange={(e) => setCatatan(e.target.value)} />}
            </Field>

            {butuhKonfirmasi ? (
              <Field label="Ketik SETUJUI untuk mengonfirmasi penghentian" galat={konfirmasi && !konfirmasiCocok ? 'Belum cocok' : null}>
                {(id) => <Input id={id} value={konfirmasi} onChange={(e) => setKonfirmasi(e.target.value)} autoComplete="off" />}
              </Field>
            ) : null}

            {galat ? <Galat error={galat} /> : null}

            <div className="flex justify-end gap-2">
              <Tombol onClick={onTutup} disabled={kirim.isPending}>
                Batal
              </Tombol>
              <Tombol
                varian={keputusan === 'setujui' ? 'bahaya' : 'utama'}
                disabled={!owner || !mfaSiap || !konfirmasiCocok}
                memuat={kirim.isPending}
                onClick={() => kirim.mutate(kasus.id)}
              >
                {LABEL[keputusan]}
              </Tombol>
            </div>
            <p className="sr-only">{pesanGalat(galat)}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Maju satu tahap FR-8.6 (pengumuman → tutup pendaftaran → … → arsip). */
export function DialogMajuSunset({ kasus, terbuka, onTutup }: { kasus: SunsetCase | null; terbuka: boolean; onTutup: () => void }) {
  const { owner } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [galat, setGalat] = useState<unknown>(null);
  const [konfirmasi, setKonfirmasi] = useState('');

  const berikut = kasus ? tahapSunsetBerikut(kasus.tahap) : null;
  const arsip = berikut === 'arsip';
  const konfirmasiCocok = !arsip || konfirmasi.trim().toUpperCase() === 'ARSIP';

  const maju = useMutation({
    mutationFn: (id: string) => api.majukanSunset(id),
    onSuccess: async (res) => {
      toast.sukses(`Tahap sunset sekarang: ${labelTahapSunset(res.data.tahap)}.`);
      setKonfirmasi('');
      setGalat(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sunset'] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
        qc.invalidateQueries({ queryKey: ['unit'] }),
        qc.invalidateQueries({ queryKey: ['summary'] }),
      ]);
      onTutup();
    },
    onError: (error) => setGalat(error),
  });

  if (!kasus) return null;
  const idx = kasus.keputusan === 'disetujui' ? URUTAN_TAHAP_SUNSET.indexOf(kasus.tahap as never) : -1;

  return (
    <Dialog
      terbuka={terbuka}
      onTutup={onTutup}
      judul="Maju tahap sunset"
      deskripsi="Menjalankan satu tahap prosedur FR-8.6. Tahap arsip menghentikan unit."
      lebar="sm"
    >
      <div className="grid gap-4">
        <ol className="grid gap-1 text-xs">
          {URUTAN_TAHAP_SUNSET.map((t, i) => (
            <li key={t} className="flex items-center gap-2">
              <span className={i <= idx ? 'size-2 rounded-full bg-accent' : 'size-2 rounded-full border border-line'} aria-hidden="true" />
              <span className={i <= idx ? 'font-medium text-fg' : 'text-muted'}>{labelTahapSunset(t)}</span>
              {i === idx ? <Badge nada="warn">sekarang</Badge> : i === idx + 1 ? <Badge nada="info">berikutnya</Badge> : null}
            </li>
          ))}
        </ol>

        {kasus.keputusan !== 'disetujui' ? (
          <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft p-2 text-xs text-warn">
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Tahap hanya dapat dimajukan setelah sunset disetujui pemilik.
          </p>
        ) : berikut ? (
          <p className="flex items-center gap-2 text-sm">
            <ArrowRight className="size-4 text-muted" aria-hidden="true" /> Tahap berikutnya:{' '}
            <strong>{labelTahapSunset(berikut)}</strong>
          </p>
        ) : (
          <p className="text-xs text-muted">Sudah di tahap terakhir (arsip). Tidak ada tahap berikutnya.</p>
        )}

        {arsip ? (
          <>
            <p className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad-soft p-2 text-xs text-bad">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              Tahap arsip mengubah status unit menjadi <strong>Dihentikan</strong> dan tidak dapat dibatalkan dari dashboard.
            </p>
            <Field label="Ketik ARSIP untuk melanjutkan" galat={konfirmasi && !konfirmasiCocok ? 'Belum cocok' : null}>
              {(id) => <Input id={id} value={konfirmasi} onChange={(e) => setKonfirmasi(e.target.value)} autoComplete="off" />}
            </Field>
          </>
        ) : null}

        {galat ? <Galat error={galat} /> : null}

        <div className="flex justify-end gap-2">
          <Tombol onClick={onTutup} disabled={maju.isPending}>
            Batal
          </Tombol>
          <Tombol
            varian={arsip ? 'bahaya' : 'utama'}
            disabled={!owner || kasus.keputusan !== 'disetujui' || !berikut || !konfirmasiCocok}
            memuat={maju.isPending}
            onClick={() => maju.mutate(kasus.id)}
          >
            Maju ke {berikut ? labelTahapSunset(berikut) : '—'}
          </Tombol>
        </div>
        {!owner ? <p className="text-[11px] text-muted">Butuh peran pemilik.</p> : null}
        {kasus.tenggatBaru ? <p className="text-[11px] text-muted">Tenggat baru: {fmtTanggal(kasus.tenggatBaru)}</p> : null}
      </div>
    </Dialog>
  );
}
