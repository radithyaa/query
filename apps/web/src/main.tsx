/**
 * Titik masuk SPA dashboard: React 19 + TanStack Router + TanStack Query +
 * Tailwind 4, dibangun Vite menjadi static assets (`apps/web/dist`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import { router } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data portofolio relatif stabil; SSE & refetchInterval menjadi penggerak utama.
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: (jumlah, error) => {
        const status = (error as { status?: number }).status ?? 0;
        // jangan ulangi galat klien (401/403/404); hanya gangguan jaringan/5xx
        if (status >= 400 && status < 500) return false;
        return jumlah < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});

const akar = document.getElementById('root');
if (!akar) throw new Error('Elemen #root tidak ditemukan');

createRoot(akar).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
