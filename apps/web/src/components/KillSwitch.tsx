/**
 * Kill switch global & per SaaS Unit (FR-1.4, FR-7.7, NFR-8).
 *
 * Aksi darurat wajib dapat dipicu dari UI dalam satu navigasi. `POST
 * /api/v1/killswitch` dengan `saas_id` juga menjeda unit tersebut, sehingga
 * mencabut kill switch per SaaS perlu diikuti `/resume` bila pemilik ingin
 * menjalankan agen lagi — form ini menyatakannya secara eksplisit.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, OctagonX, Play } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtWaktu } from '../lib/format';
import { pesanGalat, useAuth } from '../lib/auth';
import { Badge, Field, Galat, Kosong, Memuat, Select, Textarea, Tombol, useToast } from './ui';

export function KillSwitchForm({ onSelesai, saasAwal }: { onSelesai?: () => void; saasAwal?: string }) {
  const { owner } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [cakupan, setCakupan] = useState(saasAwal ?? '__global__');
  const [alasan, setAlasan] = useState('');
  const [galat, setGalat] = useState<unknown>(null);

  const { data, isLoading } = useQuery({ queryKey: ['killswitch'], queryFn: ({ signal }) => api.killswitch(signal) });
  const { data: units } = useQuery({ queryKey: ['unit', 'ringkas'], queryFn: ({ signal }) => api.units(signal), staleTime: 60_000 });

  const global = data?.data.global ?? false;
  const perSaas = new Map((data?.data.per_saas ?? []).map((s) => [s.saas_id, s]));
  const namaUnit = new Map((units?.data ?? []).map((u) => [u.id, u.nama]));
  const target = cakupan === '__global__' ? null : perSaas.get(cakupan);
  const sedangAktif = cakupan === '__global__' ? global : (target?.aktif ?? false);

  const kirim = useMutation({
    mutationFn: (aktif: boolean) => {
      const body = cakupan === '__global__' ? { aktif, alasan: alasan.trim() } : { aktif, saas_id: cakupan, alasan: alasan.trim() };
      return api.setKillswitch(body);
    },
    onSuccess: async (_res, aktif) => {
      setAlasan('');
      setGalat(null);
      // Mencabut kill switch per SaaS menyisakan flag jeda; lanjutkan dengan resume.
      if (cakupan !== '__global__' && !aktif) {
        await api.jeda(cakupan, false).catch(() => undefined);
      }
      toast.sukses(aktif ? 'Kill switch diaktifkan.' : 'Kill switch dicabut.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['killswitch'] }),
        qc.invalidateQueries({ queryKey: ['unit'] }),
        qc.invalidateQueries({ queryKey: ['summary'] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
      ]);
      onSelesai?.();
    },
    onError: (error) => setGalat(error),
  });

  if (isLoading) return <Memuat label="Memuat status kill switch…" />;
  if (!owner) {
    return (
      <Kosong
        judul="Khusus pemilik"
        deskripsi="Operator tidak dapat mengubah kill switch (keputusan darurat hanya untuk pemilik)."
        ikon={<AlertTriangle className="size-6" aria-hidden="true" />}
      />
    );
  }

  const alasanValid = alasan.trim().length >= 3 && alasan.trim().length <= 500;

  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Global</dt>
        <dd>{global ? <Badge nada="bad">AKTIF — {data?.data.global_alasan ?? 'tanpa alasan'}</Badge> : <Badge nada="ok">nonaktif</Badge>}</dd>
        <dt className="text-muted">Per SaaS</dt>
        <dd className="flex flex-wrap gap-1">
          {perSaas.size === 0 ? <span className="text-muted">tidak ada</span> : null}
          {[...perSaas.entries()].filter(([, v]) => v.aktif).map(([id, v]) => (
            <Badge key={id} nada="warn">
              {namaUnit.get(id) ?? id.slice(0, 8)} — {v.alasan}
            </Badge>
          ))}
          {perSaas.size > 0 && [...perSaas.values()].every((v) => !v.aktif) ? <span className="text-muted">semua berjalan</span> : null}
        </dd>
      </dl>

      <Field label="Cakupan" htmlFor="kill-cakupan">
        {(id) => (
          <Select id={id} value={cakupan} onChange={(e) => setCakupan(e.target.value)}>
            <option value="__global__">Seluruh sistem (global)</option>
            {(units?.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.nama}
                {perSaas.get(u.id)?.aktif ? ' — AKTIF' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Alasan" wajib hint="Wajib 3–500 karakter; tersimpan di log audit bersama aktor.">
        {(id) => (
          <Textarea
            id={id}
            value={alasan}
            maxLength={500}
            onChange={(e) => setAlasan(e.target.value)}
            placeholder={sedangAktif ? 'Contoh: insiden produksi, hentikan semua agen.' : 'Contoh: uji darurat selesai, agen boleh berjalan lagi.'}
          />
        )}
      </Field>

      {galat ? <Galat error={galat} /> : null}

      <div className="flex flex-wrap justify-end gap-2">
        {sedangAktif ? (
          <Tombol varian="sukses" disabled={!alasanValid} memuat={kirim.isPending} onClick={() => kirim.mutate(false)}>
            <Play className="size-4" aria-hidden="true" /> Cabut kill switch
          </Tombol>
        ) : (
          <Tombol varian="bahaya" disabled={!alasanValid} memuat={kirim.isPending} onClick={() => kirim.mutate(true)}>
            <OctagonX className="size-4" aria-hidden="true" /> Aktifkan kill switch
          </Tombol>
        )}
      </div>

      <section aria-labelledby="kill-riwayat" className="grid gap-1 border-t border-line pt-3">
        <h3 id="kill-riwayat" className="text-xs font-semibold text-fg">
          Riwayat 20 terakhir
        </h3>
        <ul className="grid gap-1 text-[11px] text-muted">
          {(data?.data.riwayat ?? []).slice(0, 8).map((r, i) => (
            <li key={i} className="flex flex-wrap gap-x-2">
              <span className="tabular">{fmtWaktu(Number(r['waktu']))}</span>
              <Badge nada={r['aktif'] ? 'bad' : 'ok'}>{r['aktif'] ? 'aktif' : 'dicabut'}</Badge>
              <span>{String(r['cakupan'])}</span>
              <span className="min-w-0 truncate">{String(r['alasan'] ?? '')}</span>
              <span className="text-muted">· {String(r['aktor'] ?? '')}</span>
            </li>
          ))}
          {(data?.data.riwayat ?? []).length === 0 ? <li>Belum ada riwayat.</li> : null}
        </ul>
      </section>
    </div>
  );
}
