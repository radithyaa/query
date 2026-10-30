/**
 * Primitive UI kecil (dipakai di semua halaman). Gaya mengikuti shadcn/ui
 * (dialog Radix + `cn` + kelas varian), tetapi tanpa generator komponen.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import clsx, { type ClassValue } from 'clsx';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { Nada } from '../lib/format';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

// ------------------------------------------------------------------ permukaan

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag className={cn('rounded-card border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]', className)}>
      {children}
    </Tag>
  );
}

export function CardHeader({
  judul,
  deskripsi,
  aksi,
  ikon,
}: {
  judul: ReactNode;
  deskripsi?: ReactNode;
  aksi?: ReactNode;
  ikon?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        {ikon ? <span className="mt-0.5 text-muted">{ikon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{judul}</h2>
          {deskripsi ? <p className="mt-0.5 text-xs text-muted">{deskripsi}</p> : null}
        </div>
      </div>
      {aksi ? <div className="flex flex-wrap items-center gap-2">{aksi}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ tombol

type VarianTombol = 'utama' | 'sekunder' | 'hantu' | 'bahaya' | 'sukses';
type UkuranTombol = 'sm' | 'md';

const VARIAN_TOMBOL: Record<VarianTombol, string> = {
  utama: 'bg-accent text-accent-fg hover:opacity-90 border-transparent',
  sekunder: 'bg-surface text-fg hover:bg-surface-2 border-line',
  hantu: 'bg-transparent text-muted hover:bg-surface-2 hover:text-fg border-transparent',
  bahaya: 'bg-bad text-white hover:opacity-90 border-transparent',
  sukses: 'bg-ok text-white hover:opacity-90 border-transparent',
};

const UKURAN_TOMBOL: Record<UkuranTombol, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1',
  md: 'h-9 px-3.5 text-sm gap-1.5',
};

export interface TombolProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  varian?: VarianTombol;
  ukuran?: UkuranTombol;
  memuat?: boolean;
}

export function Tombol({ varian = 'sekunder', ukuran = 'md', memuat, className, children, disabled, ...rest }: TombolProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || memuat}
      aria-busy={memuat || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-md border font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIAN_TOMBOL[varian],
        UKURAN_TOMBOL[ukuran],
        className,
      )}
    >
      {memuat ? <Pemintal /> : null}
      {children}
    </button>
  );
}

export function Pemintal({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
    />
  );
}

// ------------------------------------------------------------------ badge & indikator

const NADA_BADGE: Record<Nada, string> = {
  ok: 'border-ok/40 bg-ok-soft text-ok',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  bad: 'border-bad/40 bg-bad-soft text-bad',
  info: 'border-info/40 bg-info-soft text-info',
  netral: 'border-line bg-surface-2 text-muted',
};

export function Badge({
  children,
  nada = 'netral',
  className,
  judul,
}: {
  children: ReactNode;
  nada?: Nada;
  className?: string;
  judul?: string;
}) {
  return (
    <span
      {...(judul ? { title: judul } : {})}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
        NADA_BADGE[nada],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Health Score dengan cincin progres kecil (FR-7.1). */
export function SkorRing({ skor, ukuran = 40 }: { skor: number | null; ukuran?: number }) {
  const nilai = skor === null ? 0 : Math.max(0, Math.min(100, skor));
  const warna = skor === null ? 'var(--c-muted)' : nilai >= 70 ? 'var(--c-ok)' : nilai >= 55 ? 'var(--c-warn)' : 'var(--c-bad)';
  const jariJari = (ukuran - 6) / 2;
  const keliling = 2 * Math.PI * jariJari;
  const terisi = (nilai / 100) * keliling;
  return (
    <span className="inline-flex items-center gap-2" role="img" aria-label={`Health Score ${skor === null ? 'belum tersedia' : skor}`}>
      <svg width={ukuran} height={ukuran} viewBox={`0 0 ${ukuran} ${ukuran}`} aria-hidden="true">
        <circle cx={ukuran / 2} cy={ukuran / 2} r={jariJari} fill="none" stroke="var(--c-line)" strokeWidth={4} />
        <circle
          cx={ukuran / 2}
          cy={ukuran / 2}
          r={jariJari}
          fill="none"
          stroke={warna}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={`${terisi} ${keliling - terisi}`}
          transform={`rotate(-90 ${ukuran / 2} ${ukuran / 2})`}
        />
      </svg>
      <span className="tabular text-base font-semibold" style={{ color: warna }}>
        {skor === null ? '—' : Math.round(nilai)}
      </span>
    </span>
  );
}

/** Bar horizontal untuk komponen Health Score / pemakaian anggaran (FR-7.4). */
export function Bar({ nilai, maks = 100, nada = 'info' }: { nilai: number; maks?: number; nada?: Nada }) {
  const persen = maks <= 0 ? 0 : Math.max(0, Math.min(100, (nilai / maks) * 100));
  const warna = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', netral: 'bg-muted' }[nada];
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
      <span className={cn('block h-full rounded-full', warna)} style={{ width: `${persen}%` }} />
    </span>
  );
}

// ------------------------------------------------------------------ form

export function Field({
  label,
  hint,
  galat,
  children,
  htmlFor,
  wajib,
}: {
  label: ReactNode;
  hint?: ReactNode;
  galat?: string | null;
  children: (id: string) => ReactNode;
  htmlFor?: string;
  wajib?: boolean;
}) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-fg">
        {label}
        {wajib ? <span className="text-bad"> *</span> : null}
      </label>
      {children(id)}
      {hint && !galat ? <p className="text-[11px] text-muted">{hint}</p> : null}
      {galat ? (
        <p className="text-[11px] text-bad" role="alert">
          {galat}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn('input-dasar', className)} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cn('input-dasar pr-8', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn('input-dasar h-auto min-h-20 py-2', className)} />;
}

export function Switch({
  checked,
  onChange,
  label,
  deskripsi,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  deskripsi?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex items-start gap-3', disabled && 'opacity-60')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition',
          checked ? 'border-accent bg-accent' : 'border-line bg-surface-2',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-3.5 rounded-full shadow transition-all',
            checked ? 'left-[1.125rem] bg-accent-fg' : 'left-0.5 bg-surface',
          )}
        />
      </button>
      <div className="grid gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        {deskripsi ? <span className="text-xs text-muted">{deskripsi}</span> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ status kosong & galat

export function Kosong({ judul, deskripsi, aksi, ikon }: { judul: ReactNode; deskripsi?: ReactNode; aksi?: ReactNode; ikon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      {ikon ? <div className="text-muted">{ikon}</div> : null}
      <p className="text-sm font-medium text-fg">{judul}</p>
      {deskripsi ? <p className="max-w-md text-xs text-muted">{deskripsi}</p> : null}
      {aksi}
    </div>
  );
}

export function Galat({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const pesan = error instanceof Error ? error.message : String(error ?? 'Terjadi kesalahan');
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border-l-2 border-bad bg-bad-soft px-3 py-2 text-sm text-bad">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{pesan}</span>
      {onRetry ? (
        <Tombol ukuran="sm" onClick={onRetry}>
          Coba lagi
        </Tombol>
      ) : null}
    </div>
  );
}

export function Memuat({ label = 'Memuat…' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted" role="status">
      <Pemintal /> {label}
    </p>
  );
}

// ------------------------------------------------------------------ toast

interface Toast {
  id: number;
  pesan: string;
  jenis: 'sukses' | 'galat' | 'info';
}

interface ToastApi {
  sukses: (pesan: string) => void;
  galat: (pesan: string) => void;
  info: (pesan: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [daftar, setDaftar] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dorong = useCallback((pesan: string, jenis: Toast['jenis']) => {
    seq.current += 1;
    const id = seq.current;
    setDaftar((d) => [...d, { id, pesan, jenis }]);
    window.setTimeout(() => setDaftar((d) => d.filter((t) => t.id !== id)), jenis === 'galat' ? 8000 : 4500);
  }, []);

  const nilai = useMemo<ToastApi>(
    () => ({
      sukses: (pesan) => dorong(pesan, 'sukses'),
      galat: (pesan) => dorong(pesan, 'galat'),
      info: (pesan) => dorong(pesan, 'info'),
    }),
    [dorong],
  );

  return (
    <ToastCtx.Provider value={nilai}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {daftar.map((t) => (
          <div
            key={t.id}
            role={t.jenis === 'galat' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex w-full max-w-lg items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg',
              t.jenis === 'sukses' && 'border-ok/40 bg-ok-soft text-ok',
              t.jenis === 'galat' && 'border-bad/40 bg-bad-soft text-bad',
              t.jenis === 'info' && 'border-line bg-surface text-fg',
            )}
          >
            {t.jenis === 'sukses' ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : null}
            {t.jenis === 'galat' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : null}
            {t.jenis === 'info' ? <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1">{t.pesan}</span>
            <button
              type="button"
              className="shrink-0 opacity-70 hover:opacity-100"
              aria-label="Tutup notifikasi"
              onClick={() => setDaftar((d) => d.filter((x) => x.id !== t.id))}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast harus dipakai di dalam <ToastProvider>');
  return ctx;
}

// ------------------------------------------------------------------ dialog

/**
 * Dialog modal (Radix) dengan judul & deskripsi aksesibel: detail, keputusan
 * persetujuan, sunset, kill switch, dan pendaftaran SaaS (FR-7.7).
 */
export function Dialog({
  terbuka,
  onTutup,
  judul,
  deskripsi,
  children,
  lebar = 'md',
}: {
  terbuka: boolean;
  onTutup: () => void;
  judul: ReactNode;
  deskripsi?: ReactNode;
  children: ReactNode;
  lebar?: 'sm' | 'md' | 'lg';
}) {
  return (
    <DialogPrimitive.Root open={terbuka} onOpenChange={(o) => (o ? undefined : onTutup())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className={cn('dialog-content rounded-card border border-line bg-surface p-0 shadow-xl', {
            'max-w-md': lebar === 'sm',
            'max-w-2xl': lebar === 'md',
            'max-w-4xl': lebar === 'lg',
          })}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 rounded-t-card border-b border-line bg-surface px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-semibold text-fg">{judul}</DialogPrimitive.Title>
              {deskripsi ? (
                <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">{deskripsi}</DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Tutup">
                <X className="size-4" aria-hidden="true" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="px-4 py-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ------------------------------------------------------------------ tabel

export function Tabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-sm', className)}>{children}</table>
    </div>
  );
}

export const kelasTh = 'border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted';
export const kelasTd = 'border-b border-line px-3 py-2.5 align-top';

/** Tutup menu/popover dengan klik di luar atau Escape. */
export function useKlikLuar<T extends HTMLElement>(aktif: boolean, onLuar: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!aktif) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onLuar();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onLuar();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', esc);
    };
  }, [aktif, onLuar]);
  return ref;
}
