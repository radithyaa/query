/**
 * Root layout SPA: gerbang login + kerangka navigasi + fallback 404.
 * Provider (query client, auth, toast) dipasang di `main.tsx`.
 */
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './lib/auth';
import { LoginPage } from './components/LoginPage';
import { Shell } from './components/Shell';
import { Kosong } from './components/ui';

export function RootLayout() {
  const { sesi } = useAuth();
  const qc = useQueryClient();
  const identitas = sesi ? `${sesi.role}:${sesi.sub}:${sesi.exp}` : null;
  const sebelumnya = useRef<string | null>(identitas);

  // Kosongkan cache hanya saat identitas sesi berubah (ganti akun / keluar),
  // bukan pada mount pertama — query yang baru berjalan setelah login harus tetap ada.
  useEffect(() => {
    if (sebelumnya.current !== identitas && sebelumnya.current !== null) qc.clear();
    sebelumnya.current = identitas;
  }, [identitas, qc]);

  if (!sesi) return <LoginPage />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

export function TidakDitemukan() {
  return (
    <Kosong
      judul="Halaman tidak ditemukan"
      deskripsi={
        <Link to="/" className="text-accent underline">
          Kembali ke portofolio
        </Link>
      }
    />
  );
}
