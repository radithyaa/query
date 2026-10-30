/**
 * Sesi dashboard: token Bearer, klaim peran (FR-7.7), dan langganan SSE
 * `/api/v1/events` untuk pembaruan langsung (FR-8.8 di permukaan baca).
 *
 * Otorisasi tetap di server; `Sesi` hanya menyesuaikan tampilan (mis. tombol
 * sunset disembunyikan untuk operator, yang memang akan ditolak `403`).
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EVENT_NAMES } from '@portfolio/shared';
import { ApiError, bacaToken, sesiDashboard, simpanToken, type Sesi } from '../lib/api';

interface AuthCtx {
  token: string;
  sesi: Sesi | null;
  owner: boolean;
  masuk: (token: string) => Sesi | null;
  keluar: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => bacaToken());
  const [sesi, setSesi] = useState<Sesi | null>(() => sesiDashboard(bacaToken()));

  const masuk = useCallback((baru: string) => {
    const bersih = baru.trim();
    const klaim = sesiDashboard(bersih);
    simpanToken(bersih);
    setToken(bersih);
    setSesi(klaim);
    return klaim;
  }, []);

  const keluar = useCallback(() => {
    simpanToken('');
    setToken('');
    setSesi(null);
  }, []);

  // Token kedaluwarsa di tengah sesi → kembali ke gerbang login.
  useEffect(() => {
    if (!sesi) return;
    const sisa = sesi.exp * 1000 - Date.now();
    if (sisa <= 0) {
      keluar();
      return;
    }
    const timer = window.setTimeout(() => keluar(), Math.min(sisa, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [sesi, keluar]);

  const nilai = useMemo<AuthCtx>(
    () => ({ token, sesi, owner: sesi?.role === 'owner', masuk, keluar }),
    [token, sesi, masuk, keluar],
  );

  return <Ctx.Provider value={nilai}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam <AuthProvider>');
  return ctx;
}

/**
 * Langganan SSE: setiap event relevan membatalkan query yang terdampak sehingga
 * UI memuat ulang data dari server (sumber kebenaran), bukan menambal state lokal.
 * EventSource otomatis menyambung ulang; stream server berumur ~55 detik.
 */
export function usePeristiwaLive(aktif: boolean) {
  const qc = useQueryClient();
  const koneksi = useRef(0);
  const [status, setStatus] = useState<'mati' | 'menghubungkan' | 'hidup'>('mati');

  useEffect(() => {
    if (!aktif) {
      setStatus('mati');
      return;
    }
    const token = bacaToken();
    if (!token) return;
    koneksi.current += 1;
    const es = new EventSource(`/api/v1/events?access_token=${encodeURIComponent(token)}`);
    setStatus('menghubungkan');

    const segarkan = (kunci: string[]) => {
      for (const k of kunci) void qc.invalidateQueries({ queryKey: [k] });
    };

    es.addEventListener('open', () => setStatus('hidup'));
    const umum = ['summary', 'unit', 'status', 'approvals', 'sunset'];
    for (const nama of EVENT_NAMES) {
      es.addEventListener(nama, () => {
        if (nama === 'metric.ingested' || nama === 'health.evaluated') segarkan(['summary', 'status', 'unit']);
        else if (nama.startsWith('approval.')) segarkan(['approvals', 'summary', 'status']);
        else if (nama.startsWith('sunset.')) segarkan(['sunset', 'status', 'unit']);
        else if (nama === 'killswitch.activated') segarkan(['killswitch', 'summary', 'unit']);
        else segarkan(umum);
      });
    }
    es.onerror = () => setStatus('menghubungkan');

    return () => {
      es.close();
      koneksi.current -= 1;
      setStatus('mati');
    };
  }, [aktif, qc]);

  return status;
}

/** Pesan galat yang ramah untuk aksi tulis (dipakai toast). */
export function pesanGalat(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.belumLogin) return 'Sesi berakhir. Masuk kembali.';
    if (error.mfaDiperlukan) return `${error.message}. Isi token MFA untuk melanjutkan.`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
