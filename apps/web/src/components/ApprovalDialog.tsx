/**
 * Keputusan persetujuan (FR-7.3, FR-7.7): setujui / tolak / minta revisi untuk
 * draf konten, balasan ulasan, PR, rencana pemulihan, dan permintaan lain.
 *
 * Kategori khusus pemilik (`merge_pr`, `ubah_harga`, `beli_iklan`, `rc_plan`,
 * `sunset`) dinonaktifkan untuk operator — server tetap menolak dengan `403`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type Approval } from '../lib/api';
import { pesanGalat, useAuth } from '../lib/auth';
import { APPROVAL_KHUSUS_PEMILIK, fmtSisa, fmtWaktu, labelApproval, labelFungsi } from '../lib/format';
import { Badge, Dialog, Field, Galat, Input, Textarea, Tombol, useToast } from './ui';

type Keputusan = 'setujui' | 'tolak' | 'revisi';

const LABEL_KEPUTUSAN: Record<Keputusan, string> = {
  setujui: 'Setujui',
  tolak: 'Tolak',
  revisi: 'Minta revisi',
};

/** Ringkasan isi payload berdasarkan tindakan (draf konten, balasan ulasan, PR). */
function IsiPermintaan({ approval }: { approval: Approval }) {
  const isi = (approval.payload?.payload ?? {}) as Record<string, unknown>;
  const tindakan = String(approval.payload?.tindakan ?? '');
  const teks = (k: string) => (isi[k] === undefined || isi[k] === null ? null : String(isi[k]));

  if (tindakan === 'terbit_post' || tindakan === 'jadwalkan_post' || tindakan === 'simpan_konten') {
    const kanal = teks('kanal');
    const jadwal = teks('jadwal');
    return (
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-1">
          {kanal ? <Badge nada="info">{kanal}</Badge> : null}
          {jadwal ? <Badge>jadwal {jadwal}</Badge> : null}
          {Array.isArray(isi['hashtag']) ? (isi['hashtag'] as unknown[]).map((h) => <Badge key={String(h)}>#{String(h).replace(/^#/, '')}</Badge>) : null}
        </div>
        {teks('judul') ? <p className="text-sm font-medium text-fg">{teks('judul')}</p> : null}
        {teks('body') ? <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-xs text-fg">{teks('body')}</p> : null}
        {isi['pemeriksaan_klaim'] ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">Pemeriksaan klaim</summary>
            <pre className="mt-1 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(isi['pemeriksaan_klaim'], null, 2)}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (tindakan === 'balas_ulasan') {
    return (
      <div className="grid gap-2 text-xs">
        {teks('review_id') ? <p className="text-muted">Ulasan {teks('review_id')}</p> : null}
        {teks('teks_ulasan') ? <p className="rounded-md bg-surface-2 p-2">“{teks('teks_ulasan')}”</p> : null}
        {teks('teks') ? <p className="whitespace-pre-wrap rounded-md border border-line p-2">{teks('teks')}</p> : null}
      </div>
    );
  }

  if (tindakan === 'buka_pr' || tindakan === 'merge_pr') {
    const url = teks('url') ?? (teks('nomor') ? `${teks('repo') ?? ''}#${teks('nomor')}` : null);
    return (
      <div className="grid gap-1 text-xs">
        {teks('judul') ? <p className="text-sm font-medium text-fg">{teks('judul')}</p> : null}
        <p className="text-muted">
          {teks('repo') ?? 'repo'}#{teks('nomor') ?? '?'}
          {isi['ci_lulus'] === true ? ' · CI lulus' : isi['ci_lulus'] === false ? ' · CI gagal' : ''}
        </p>
        {teks('ringkasan') ? <p className="whitespace-pre-wrap">{teks('ringkasan')}</p> : null}
        {url && /^https?:/.test(url) ? (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline">
            Buka PR <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted">Isi payload</summary>
      <pre className="mt-1 max-h-56 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(approval.payload, null, 2)}</pre>
    </details>
  );
}

export function DialogKeputusan({
  approval,
  terbuka,
  onTutup,
  gambar,
}: {
  approval: Approval | null;
  terbuka: boolean;
  onTutup: () => void;
  /** teks konfirmasi tambahan, mis. "ketik SETUJUI untuk merge PR" */
  gambar?: string;
}) {
  const { owner } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [keputusan, setKeputusan] = useState<Keputusan>('setujui');
  const [catatan, setCatatan] = useState('');
  const [konfirmasi, setKonfirmasi] = useState('');
  const [galat, setGalat] = useState<unknown>(null);

  const khususPemilik = approval ? APPROVAL_KHUSUS_PEMILIK.has(approval.jenis) : false;
  const terblokir = khususPemilik && !owner;
  const butuhKonfirmasi = Boolean(gambar) && keputusan === 'setujui';
  const konfirmasiCocok = !butuhKonfirmasi || konfirmasi.trim().toUpperCase() === (gambar ?? '').toUpperCase();

  const kirim = useMutation({
    mutationFn: (id: string) => api.putuskanApproval(id, keputusan, catatan),
    onSuccess: async () => {
      toast.sukses(`Permintaan ${LABEL_KEPUTUSAN[keputusan].toLowerCase()} dan tercatat di audit.`);
      setCatatan('');
      setKonfirmasi('');
      setGalat(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['approvals'] }),
        qc.invalidateQueries({ queryKey: ['summary'] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
        qc.invalidateQueries({ queryKey: ['sunset'] }),
      ]);
      onTutup();
    },
    onError: (error) => setGalat(error),
  });

  const sisa = useMemo(() => (approval ? fmtSisa(approval.kedaluwarsa) : '—'), [approval]);

  if (!approval) return null;

  return (
    <Dialog
      terbuka={terbuka}
      onTutup={() => {
        setGalat(null);
        onTutup();
      }}
      judul={labelApproval(approval.jenis)}
      deskripsi={`${approval.ringkasanDampak} · ${labelFungsi(approval.fungsi)} · kedaluwarsa ${sisa}`}
      lebar="md"
    >
      <div className="grid gap-4">
        <IsiPermintaan approval={approval} />

        <div className="flex flex-wrap gap-1 text-[11px] text-muted">
          <Badge nada={approval.status === 'menunggu' ? 'warn' : approval.status === 'disetujui' ? 'ok' : 'bad'}>{approval.status}</Badge>
          <span>diajukan {fmtWaktu(approval.dibuatPada)}</span>
          {khususPemilik ? <Badge nada="info">khusus pemilik</Badge> : null}
        </div>

        {approval.status !== 'menunggu' ? (
          <p className="rounded-md bg-surface-2 p-2 text-xs text-muted">
            Permintaan ini sudah diputuskan{approval.diputuskanOleh ? ` oleh ${approval.diputuskanOleh}` : ''}
            {approval.diputuskanPada ? ` pada ${fmtWaktu(approval.diputuskanPada)}` : ''}.
            {approval.catatan ? ` Catatan: ${approval.catatan}` : ''}
          </p>
        ) : (
          <>
            {terblokir ? (
              <p className="rounded-md border border-warn/40 bg-warn-soft p-2 text-xs text-warn">
                Hanya pemilik yang dapat memutuskan {labelApproval(approval.jenis).toLowerCase()}. Anda masuk sebagai operator.
              </p>
            ) : null}

            <fieldset className="grid gap-2">
              <legend className="text-xs font-medium text-fg">Keputusan</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup">
                {(['setujui', 'revisi', 'tolak'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={keputusan === k}
                    onClick={() => setKeputusan(k)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                      keputusan === k
                        ? k === 'setujui'
                          ? 'border-ok bg-ok-soft text-ok'
                          : k === 'tolak'
                            ? 'border-bad bg-bad-soft text-bad'
                            : 'border-warn bg-warn-soft text-warn'
                        : 'border-line text-muted hover:bg-surface-2'
                    }`}
                  >
                    {LABEL_KEPUTUSAN[k]}
                  </button>
                ))}
              </div>
            </fieldset>

            <Field label="Catatan" hint="Opsional (maks 2000 karakter). Untuk beberapa keputusan, catatan menjadi bagian dari audit.">
              {(id) => <Textarea id={id} value={catatan} maxLength={2000} onChange={(e) => setCatatan(e.target.value)} />}
            </Field>

            {butuhKonfirmasi ? (
              <Field label={`Ketik ${gambar} untuk mengonfirmasi`} galat={konfirmasi && !konfirmasiCocok ? `Harus sama dengan ${gambar}` : null}>
                {(id) => <Input id={id} value={konfirmasi} onChange={(e) => setKonfirmasi(e.target.value)} autoComplete="off" />}
              </Field>
            ) : null}

            {galat ? <Galat error={galat} /> : null}

            <div className="flex justify-end gap-2">
              <Tombol onClick={onTutup} disabled={kirim.isPending}>
                Batal
              </Tombol>
              <Tombol
                varian={keputusan === 'setujui' ? 'sukses' : keputusan === 'tolak' ? 'bahaya' : 'sekunder'}
                disabled={terblokir || !konfirmasiCocok}
                memuat={kirim.isPending}
                onClick={() => kirim.mutate(approval.id)}
              >
                {LABEL_KEPUTUSAN[keputusan]}
              </Tombol>
            </div>
            {galat ? null : <p className="sr-only">{pesanGalat(galat)}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}
