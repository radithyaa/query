/**
 * Konektor sumber data (§3.1, §7.1). Setiap konektor mengambil data dari sistem
 * eksternal; pada mode lokal semuanya memakai implementasi mock deterministik
 * sehingga tidak ada panggilan keluar.
 */
import type { ContentKanal, DailyMetric, Fungsi } from '@portfolio/shared';

export interface ConnectorContext {
  saasId: string;
  slug: string;
  /** kredensial hasil resolusi `secret_ref` — tidak boleh masuk log */
  secret: string | null;
  detail: Record<string, unknown>;
  now: number;
}

export interface PlayReview {
  reviewId: string;
  rating: number;
  teks: string;
  versiAplikasi: string | null;
  perangkat: string | null;
  tanggal: number;
}

export interface PlayConnector {
  listReviews(ctx: ConnectorContext, opts?: { limit?: number }): Promise<PlayReview[]>;
  replyReview(ctx: ConnectorContext, reviewId: string, teks: string): Promise<{ ok: boolean; id: string }>;
}

export interface GitHubIssue {
  nomor: number;
  judul: string;
  body: string;
  labels: string[];
  url: string;
}

export interface GitHubConnector {
  listIssues(ctx: ConnectorContext, opts?: { labels?: string[]; limit?: number }): Promise<GitHubIssue[]>;
  createIssue(ctx: ConnectorContext, input: { judul: string; body: string; labels: string[] }): Promise<GitHubIssue>;
  createPullRequest(
    ctx: ConnectorContext,
    input: { judul: string; body: string; branch: string; baseBranch: string; perubahan: Array<{ file: string; isi: string }> },
  ): Promise<{ nomor: number; url: string; ciLulus: boolean }>;
}

export interface InstagramConnector {
  publish(ctx: ConnectorContext, input: { caption: string; mediaUrl: string | null }): Promise<{ id: string; permalink: string }>;
  insights(ctx: ConnectorContext, id: string): Promise<{ jangkauan: number; interaksi: number; klik: number; konversi: number }>;
}

export interface SentryConnector {
  listIssues(ctx: ConnectorContext): Promise<Array<{ fingerprint: string; judul: string; jumlah: number; pertama: number; terakhir: number; stack: string }>>;
}

export interface BillingConnector {
  snapshot(ctx: ConnectorContext): Promise<{ mrr: number; pelangganAktif: number; mataUang: string }>;
}

export interface AnalyticsConnector {
  snapshot(ctx: ConnectorContext): Promise<{ dau: number; mau: number; aktivasi: number }>;
}

export interface NotificationSink {
  kirim(input: { ke: string; judul: string; isi: string; url?: string }): Promise<{ ok: boolean; id: string }>;
}

/** Kumpulan konektor yang dipakai agen dan siklus harian. */
export interface ConnectorSet {
  play: PlayConnector;
  github: GitHubConnector;
  instagram: InstagramConnector;
  sentry: SentryConnector;
  billing: BillingConnector;
  analytics: AnalyticsConnector;
}

export type AdaKonektor = keyof ConnectorSet;

export interface ContentMetric {
  kanal: ContentKanal;
  kontenId: string;
  jangkauan: number;
  interaksi: number;
  klik: number;
  konversi: number;
}

export interface DailyCollection {
  metric: Partial<DailyMetric> & { tanggal: string };
  sourceOk: Record<string, boolean>;
}

export function connectorFor(fungsi: Fungsi): AdaKonektor[] {
  switch (fungsi) {
    case 'review':
      return ['play'];
    case 'kode':
      return ['github', 'sentry'];
    case 'promosi':
      return ['instagram', 'analytics'];
    case 'support':
      return [];
    case 'parent':
      return ['billing', 'analytics', 'play', 'github'];
  }
}
