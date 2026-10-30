/**
 * Pendaftaran SaaS Unit (FR-1.1, FR-1.3, FR-10 "penambahan baru hanya konfigurasi
 * dan konektor"). Validasi memakai skema Zod yang sama dengan API, sehingga galat
 * muncul di form sebelum permintaan dikirim.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CreateSaasRequest, KONEKTOR_JENIS, type KonektorJenis } from '@portfolio/shared';
import { panggil } from '../lib/api';
import { pesanGalat } from '../lib/auth';
import { slugify } from '../lib/format';
import { cn, Dialog, Field, Galat, Input, Textarea, Tombol, useToast } from './ui';

const KONEKTOR_UTAMA: KonektorJenis[] = ['billing', 'analytics', 'play'];

interface KonektorDraft {
  jenis: KonektorJenis;
  secret_ref: string;
  utama: boolean;
}

export function DialogDaftarSaas({ terbuka, onTutup }: { terbuka: boolean; onTutup: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [nama, setNama] = useState('');
  const [slug, setSlug] = useState('');
  const [slugDisentuh, setSlugDisentuh] = useState(false);
  const [repo, setRepo] = useState('');
  const [akunToko, setAkunToko] = useState('');
  const [platform, setPlatform] = useState('android');
  const [panduan, setPanduan] = useState('');
  const [anggaran, setAnggaran] = useState('20');
  const [konektor, setKonektor] = useState<KonektorDraft[]>([]);
  const [galat, setGalat] = useState<string | null>(null);
  const [kesalahan, setKesalahan] = useState<Record<string, string>>({});

  const slugAkhir = slugDisentuh ? slug : slugify(nama);

  const simpan = useMutation({
    mutationFn: () => {
      const body = {
        slug: slugAkhir,
        nama: nama.trim(),
        status: 'aktif' as const,
        platform: platform
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(akunToko.trim() ? { akun_toko: akunToko.trim() } : {}),
        config: {
          ...(panduan.trim() ? { panduan_merek: panduan.trim() } : {}),
          ...(Number(anggaran) > 0
            ? { anggaran_bulanan_usd: { review: Number(anggaran), support: Number(anggaran), promosi: Number(anggaran), kode: Number(anggaran) } }
            : {}),
        },
        konektor: konektor
          .filter((k) => k.secret_ref.trim())
          .map((k) => ({ jenis: k.jenis, secret_ref: k.secret_ref.trim(), detail: {}, utama: k.utama })),
      };
      const parsed = CreateSaasRequest.safeParse(body);
      if (!parsed.success) {
        const peta: Record<string, string> = {};
        for (const issue of parsed.error.issues) peta[issue.path.join('.') || 'root'] = issue.message;
        setKesalahan(peta);
        throw new Error('Periksa kembali isian yang ditandai.');
      }
      return panggil<{ data: { id: string; nama: string } }>('/saas', { method: 'POST', body: parsed.data });
    },
    onSuccess: async (res) => {
      toast.sukses(`${res.data.nama} terdaftar.`);
      setGalat(null);
      setKesalahan({});
      setNama('');
      setSlug('');
      setSlugDisentuh(false);
      setRepo('');
      setAkunToko('');
      setPanduan('');
      setKonektor([]);
      await Promise.all([qc.invalidateQueries({ queryKey: ['summary'] }), qc.invalidateQueries({ queryKey: ['unit'] })]);
      onTutup();
    },
    onError: (error) => setGalat(pesanGalat(error)),
  });

  function toggleKonektor(jenis: KonektorJenis) {
    setKonektor((lama) => {
      const ada = lama.find((k) => k.jenis === jenis);
      if (ada) return lama.filter((k) => k.jenis !== jenis);
      return [...lama, { jenis, secret_ref: `secret://${jenis}`, utama: KONEKTOR_UTAMA.includes(jenis) }];
    });
  }

  return (
    <Dialog
      terbuka={terbuka}
      onTutup={onTutup}
      judul="Daftarkan SaaS Unit"
      deskripsi="Setiap unit mendapat agen Promosi, Review, Engineering, dan Support; konektor menyuplai metrik harian."
      lebar="md"
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setGalat(null);
          setKesalahan({});
          simpan.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nama" wajib galat={kesalahan['nama']}>
            {(id) => (
              <Input id={id} value={nama} required minLength={2} maxLength={160} onChange={(e) => setNama(e.target.value)} placeholder="Contoh: LaporanKu" />
            )}
          </Field>
          <Field
            label="Slug"
            wajib
            hint="Huruf kecil, angka, tanda hubung. Menjadi identitas unit."
            galat={kesalahan['slug']}
          >
            {(id) => (
              <Input
                id={id}
                value={slugAkhir}
                required
                pattern="[a-z0-9][a-z0-9-]*"
                onChange={(e) => {
                  setSlugDisentuh(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
          <Field label="Repo GitHub" hint="Format org/nama (dipakai Agen Kode)." galat={kesalahan['repo']}>
            {(id) => <Input id={id} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="org/laporanku" />}
          </Field>
          <Field label="Akun toko / paket aplikasi" galat={kesalahan['akun_toko']}>
            {(id) => <Input id={id} value={akunToko} onChange={(e) => setAkunToko(e.target.value)} placeholder="com.contoh.laporanku" />}
          </Field>
          <Field label="Platform" hint="Pisahkan dengan koma.">
            {(id) => <Input id={id} value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="android, ios, web" />}
          </Field>
          <Field label="Anggaran agen / fungsi (USD/bulan)" hint="Dipakai policy gateway; 0 = tanpa batas eksplisit.">
            {(id) => <Input id={id} type="number" min={0} step={1} value={anggaran} onChange={(e) => setAnggaran(e.target.value)} />}
          </Field>
        </div>

        <Field label="Panduan merek" hint="Opsional; masuk ke prompt agen (maks 4000 karakter).">
          {(id) => <Textarea id={id} maxLength={4000} value={panduan} onChange={(e) => setPanduan(e.target.value)} />}
        </Field>

        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-fg">Konektor</legend>
          <p className="text-[11px] text-muted">Kredensial hanya disimpan sebagai `secret_ref`, bukan nilai rahasia (NFR-12).</p>
          <div className="flex flex-wrap gap-1.5">
            {KONEKTOR_JENIS.map((j) => {
              const aktif = konektor.some((k) => k.jenis === j);
              return (
                <button
                  key={j}
                  type="button"
                  aria-pressed={aktif}
                  onClick={() => toggleKonektor(j)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs capitalize',
                    aktif ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:bg-surface-2',
                  )}
                >
                  {j}
                </button>
              );
            })}
          </div>
          {konektor.map((k) => (
            <div key={k.jenis} className="grid gap-2 rounded-md bg-surface-2 p-2 sm:grid-cols-[5rem_1fr_auto]">
              <span className="text-xs font-medium">{k.jenis}</span>
              <Input
                className="h-8 text-xs"
                aria-label={`secret_ref ${k.jenis}`}
                value={k.secret_ref}
                onChange={(e) => setKonektor((lama) => lama.map((x) => (x.jenis === k.jenis ? { ...x, secret_ref: e.target.value } : x)))}
              />
              <label className="flex items-center gap-1 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={k.utama}
                  onChange={(e) => setKonektor((lama) => lama.map((x) => (x.jenis === k.jenis ? { ...x, utama: e.target.checked } : x)))}
                />
                utama
              </label>
            </div>
          ))}
        </fieldset>

        {kesalahan['konektor'] || kesalahan['config'] ? (
          <p className="text-xs text-bad">{kesalahan['konektor'] ?? kesalahan['config']}</p>
        ) : null}
        {galat ? <Galat error={galat} /> : null}

        <div className="flex justify-end gap-2">
          <Tombol onClick={onTutup} disabled={simpan.isPending}>
            Batal
          </Tombol>
          <Tombol type="submit" varian="utama" memuat={simpan.isPending} disabled={!nama.trim() || !slugAkhir}>
            Daftarkan
          </Tombol>
        </div>
      </form>
    </Dialog>
  );
}
