/**
 * Kerangka halaman: navigasi (FR-7.1–7.6) dan aksi darurat pemilik
 * (FR-7.7 — kill switch dijangkau satu navigasi dari portofolio, NFR-8).
 */
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BookLock,
  CalendarRange,
  Coins,
  LayoutDashboard,
  LogOut,
  Moon,
  OctagonX,
  Power,
  ShieldAlert,
  Sun,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, usePeristiwaLive } from '../lib/auth';
import { fmtAngka, fmtWaktu } from '../lib/format';
import { Badge, cn, Dialog, Tombol, useToast } from './ui';
import { KillSwitchForm } from './KillSwitch';

const MENU: ReadonlyArray<{ ke: '/' | '/persetujuan' | '/sunset' | '/biaya' | '/laporan' | '/audit'; label: string; ikon: typeof LayoutDashboard; hitung?: boolean }> = [
  { ke: '/', label: 'Portofolio', ikon: LayoutDashboard },
  { ke: '/persetujuan', label: 'Persetujuan', ikon: BookLock, hitung: true },
  { ke: '/sunset', label: 'Sunset', ikon: CalendarRange },
  { ke: '/biaya', label: 'Biaya', ikon: Coins },
  { ke: '/laporan', label: 'Laporan', ikon: Users },
  { ke: '/audit', label: 'Log audit', ikon: Activity },
];

type Tema = 'sistem' | 'terang' | 'gelap';

function bacaTema(): Tema {
  try {
    const t = localStorage.getItem('portfolio.theme');
    return t === 'light' ? 'terang' : t === 'dark' ? 'gelap' : 'sistem';
  } catch {
    return 'sistem';
  }
}

function terapkanTema(tema: Tema) {
  const akar = document.documentElement;
  if (tema === 'sistem') delete akar.dataset.theme;
  else akar.dataset.theme = tema === 'gelap' ? 'dark' : 'light';
  try {
    if (tema === 'sistem') localStorage.removeItem('portfolio.theme');
    else localStorage.setItem('portfolio.theme', tema === 'gelap' ? 'dark' : 'light');
  } catch {
    // abaikan storage yang diblokir
  }
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { sesi, owner, keluar } = useAuth();
  const toast = useToast();
  const [tema, setTema] = useState<Tema>(bacaTema);
  const [killBuka, setKillBuka] = useState(false);
  const live = usePeristiwaLive(Boolean(sesi));
  const path = useRouterState({ select: (s) => s.location.pathname });

  const { data: kill } = useQuery({ queryKey: ['killswitch'], queryFn: ({ signal }) => api.killswitch(signal), refetchInterval: 60_000 });
  const { data: ops } = useQuery({ queryKey: ['ops'], queryFn: ({ signal }) => api.ops(signal), refetchInterval: 60_000 });

  useEffect(() => {
    terapkanTema(tema);
  }, [tema]);

  const globalAktif = kill?.data.global ?? false;
  const aktifPerSaas = (kill?.data.per_saas ?? []).filter((s) => s.aktif);
  const jumlahJeda = aktifPerSaas.length;

  // Beri tahu pemilik ketika kill switch global berubah menjadi aktif.
  const sebelumnya = useRef(globalAktif);
  useEffect(() => {
    if (globalAktif && !sebelumnya.current) toast.galat(`Kill switch global AKTIF: ${kill?.data.global_alasan ?? 'tanpa alasan'}`);
    sebelumnya.current = globalAktif;
  }, [globalAktif, kill?.data.global_alasan, toast]);

  const hitungMenunggu = ops?.data.persetujuan_menunggu ?? 0;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1400px] flex-col lg:flex-row">
      <aside className="no-print flex shrink-0 flex-col gap-4 border-b border-line bg-surface px-3 py-3 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-2 px-1">
          <Link to="/" className="flex items-center gap-2 no-underline">
            <span className="grid size-7 place-items-center rounded-md bg-accent text-accent-fg">
              <Activity className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-fg">Portofolio SaaS</span>
          </Link>
        </div>

        <nav aria-label="Navigasi utama" className="flex flex-wrap gap-1 lg:flex-col">
          {MENU.map((item) => {
            const aktif = item.ke === '/' ? path === '/' : path.startsWith(item.ke);
            const Ikon = item.ikon;
            const angka = item.hitung ? hitungMenunggu : 0;
            return (
              <Link
                key={item.ke}
                to={item.ke}
                aria-current={aktif ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm no-underline transition',
                  aktif ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                <Ikon className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{item.label}</span>
                {angka > 0 ? <Badge nada="warn">{fmtAngka(angka)}</Badge> : null}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto grid gap-2 border-t border-line pt-3">
          <Tombol
            varian={globalAktif ? 'bahaya' : 'sekunder'}
            ukuran="sm"
            className="justify-start"
            onClick={() => setKillBuka(true)}
            aria-haspopup="dialog"
          >
            <OctagonX className="size-4" aria-hidden="true" />
            {globalAktif ? 'Kill switch AKTIF' : 'Kill switch'}
            {jumlahJeda > 0 ? <Badge nada="warn">{jumlahJeda}</Badge> : null}
          </Tombol>

          <div className="flex items-center gap-1">
            <Tombol
              varian="hantu"
              ukuran="sm"
              onClick={() => setTema(tema === 'gelap' ? 'terang' : tema === 'terang' ? 'sistem' : 'gelap')}
              title={`Tema: ${tema}`}
              aria-label={`Ganti tema (sekarang ${tema})`}
            >
              {tema === 'gelap' ? <Moon className="size-4" aria-hidden="true" /> : tema === 'terang' ? <Sun className="size-4" aria-hidden="true" /> : <Power className="size-4" aria-hidden="true" />}
              <span className="capitalize">{tema}</span>
            </Tombol>
            <span
              className={cn(
                'ml-auto inline-flex items-center gap-1 text-[11px]',
                live === 'hidup' ? 'text-ok' : live === 'menghubungkan' ? 'text-warn' : 'text-muted',
              )}
              title={live === 'hidup' ? 'Pembaruan langsung aktif (SSE)' : 'Pembaruan langsung tidak aktif'}
            >
              <span className={cn('size-1.5 rounded-full', live === 'hidup' ? 'bg-ok' : live === 'menghubungkan' ? 'bg-warn' : 'bg-muted')} />
              {live === 'hidup' ? 'live' : live === 'menghubungkan' ? 'menyambung' : 'diam'}
            </span>
          </div>

          <div className="grid gap-1 rounded-md bg-surface-2 px-2 py-1.5">
            <p className="truncate text-xs font-medium text-fg" title={sesi?.email ?? sesi?.sub}>
              {sesi?.email ?? sesi?.sub}
            </p>
            <div className="flex items-center justify-between gap-2">
              <Badge nada={owner ? 'info' : 'netral'}>{owner ? 'Pemilik' : 'Operator'}</Badge>
              <button type="button" onClick={keluar} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg">
                <LogOut className="size-3" aria-hidden="true" /> Keluar
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {globalAktif ? (
          <div role="alert" className="no-print flex flex-wrap items-center gap-2 border-b border-bad/40 bg-bad-soft px-4 py-2 text-xs text-bad">
            <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
            <strong>Kill switch global aktif.</strong>
            <span className="min-w-0">Semua agen berhenti menerima job. {kill?.data.global_alasan ? `Alasan: ${kill.data.global_alasan}` : ''}</span>
            <Tombol ukuran="sm" varian="bahaya" className="ml-auto" onClick={() => setKillBuka(true)}>
              Kelola
            </Tombol>
          </div>
        ) : null}
        {jumlahJeda > 0 ? (
          <div role="status" className="no-print flex flex-wrap items-center gap-2 border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-xs text-warn">
            <OctagonX className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              Kill switch aktif untuk {jumlahJeda} SaaS Unit: {aktifPerSaas.map((s) => s.saas_id.slice(0, 8)).join(', ')}.
            </span>
            <Tombol ukuran="sm" className="ml-auto" onClick={() => setKillBuka(true)}>
              Kelola
            </Tombol>
          </div>
        ) : null}
        <main className="min-w-0 px-4 py-5 lg:px-6">
          {children}
          <footer className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[11px] text-muted">
            <span>Data dari <code>/api/v1</code> · diperbarui {fmtWaktu(Date.now())}</span>
            <span className="ml-auto">Zona waktu Indonesia Barat (WIB)</span>
          </footer>
        </main>
      </div>

      <Dialog
        terbuka={killBuka}
        onTutup={() => setKillBuka(false)}
        judul="Kill switch"
        deskripsi="Menghentikan penerimaan job seketika (NFR-8). Setiap perubahan dicatat di log audit."
        lebar="md"
      >
        <KillSwitchForm onSelesai={() => setKillBuka(false)} />
      </Dialog>
    </div>
  );
}
