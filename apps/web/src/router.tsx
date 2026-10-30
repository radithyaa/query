/**
 * Rute SPA (TanStack Router). File-based routing tidak dipakai karena halaman
 * menyimpan filter di `search` URL (FR-7.6) dengan validator eksplisit per rute.
 * `path` ditulis sebagai string biasa: helper `createRoute` menafsirkan literal
 * seperti `'/'` sebagai path relatif.
 */
import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { RootLayout, TidakDitemukan } from './root';
import { PortfolioPage } from './pages/PortfolioPage';
import { SaasPage } from './pages/SaasPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { SunsetPage } from './pages/SunsetPage';
import { CostPage } from './pages/CostPage';
import { ReportsPage } from './pages/ReportsPage';
import { AuditPage } from './pages/AuditPage';

// ------------------------------------------------------------------ validator search

const periode = z.coerce
  .number()
  .int()
  .refine((v) => v === 7 || v === 28 || v === 90)
  .optional()
  .catch(undefined);
const teks = z.string().trim().min(1).optional().catch(undefined);
const tanggal = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);
const offset = z.coerce.number().int().min(0).max(1_000_000).optional().catch(undefined);

export const searchPortofolio = z.object({ periode, status: teks, q: teks });
export const searchUnit = z.object({ periode });
export const searchPersetujuan = z.object({
  saas: teks,
  fungsi: teks,
  jenis: teks,
  status: z.enum(['menunggu', 'disetujui', 'ditolak', 'revisi', 'kedaluwarsa']).optional().catch(undefined),
});
export const searchAudit = z.object({ saas: teks, aktor: teks, tindakan: teks, dari: tanggal, sampai: tanggal, offset });

// ------------------------------------------------------------------ rute

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: TidakDitemukan });

const PORTFOLIO = '/';
const UNIT = '/saas/$id';
const PERSETUJUAN = '/persetujuan';
const SUNSET = '/sunset';
const BIAYA = '/biaya';
const LAPORAN = '/laporan';
const AUDIT = '/audit';
const DASHBOARD = '/dashboard';

const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PORTFOLIO,
  validateSearch: searchPortofolio,
  component: PortfolioPage,
});

const unitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: UNIT,
  validateSearch: searchUnit,
  component: SaasPage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PERSETUJUAN,
  validateSearch: searchPersetujuan,
  component: ApprovalsPage,
});

const sunsetRoute = createRoute({ getParentRoute: () => rootRoute, path: SUNSET, component: SunsetPage });
const costRoute = createRoute({ getParentRoute: () => rootRoute, path: BIAYA, component: CostPage });
const reportsRoute = createRoute({ getParentRoute: () => rootRoute, path: LAPORAN, component: ReportsPage });

const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: AUDIT, validateSearch: searchAudit, component: AuditPage });

/** Alias: URL lama `/dashboard` (README, Workers) tetap bekerja. */
const dashboardAlias = createRoute({
  getParentRoute: () => rootRoute,
  path: DASHBOARD,
  beforeLoad: () => {
    throw redirect({ to: PORTFOLIO, replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  portfolioRoute,
  unitRoute,
  approvalsRoute,
  sunsetRoute,
  costRoute,
  reportsRoute,
  auditRoute,
  dashboardAlias,
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
