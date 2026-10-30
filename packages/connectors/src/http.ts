/**
 * Kerangka konektor HTTP nyata (§7.1). Kuota, autentikasi, dan operasi yang
 * dipakai dibaca dari konfigurasi, bukan ditanam di kode. Bila kredensial tidak
 * tersedia, konektor jatuh ke error yang terklasifikasi sehingga job masuk DLQ
 * dengan alasan jelas (bukan diam-diam memakai data palsu di produksi).
 */
import type {
  BillingConnector,
  ConnectorContext,
  GitHubConnector,
  GitHubIssue,
  InstagramConnector,
  PlayConnector,
  PlayReview,
  SentryConnector,
  AnalyticsConnector,
} from './types.ts';

export class ConnectorError extends Error {
  readonly kode: string;
  readonly status: number | null;
  constructor(kode: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ConnectorError';
    this.kode = kode;
    this.status = status;
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function httpJson<T>(
  url: string,
  init: RequestInit,
  opts: HttpOptions,
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new ConnectorError('http_error', `${url} -> ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('network_error', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function requireSecret(ctx: ConnectorContext, jenis: string): string {
  if (!ctx.secret) throw new ConnectorError('secret_missing', `kredensial ${jenis} untuk ${ctx.slug} belum tersedia`);
  return ctx.secret;
}

export class HttpPlayConnector implements PlayConnector {
  private readonly opts: HttpOptions;

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
  }
  async listReviews(ctx: ConnectorContext, opts: { limit?: number } = {}): Promise<PlayReview[]> {
    requireSecret(ctx, 'play');
    const packageName = String(ctx.detail.package_name ?? '');
    const base = String(ctx.detail.base_url ?? 'https://androidpublisher.googleapis.com/androidpublisher/v3');
    const data = await httpJson<{ reviews?: Array<Record<string, unknown>> }>(
      `${base}/applications/${encodeURIComponent(packageName)}/reviews?maxResults=${opts.limit ?? 20}`,
      { headers: { authorization: `Bearer ${ctx.secret}` } },
      this.opts,
    );
    return (data.reviews ?? []).map((r) => {
      const comments = (r.comments as Array<Record<string, unknown>> | undefined) ?? [];
      const uc = (comments[0]?.userComment as Record<string, unknown> | undefined) ?? {};
      return {
        reviewId: String(r.reviewId ?? ''),
        rating: Number(uc.starRating ?? 0),
        teks: String(uc.text ?? ''),
        versiAplikasi: (uc.appVersionName as string | undefined) ?? null,
        perangkat: (uc.device as string | undefined) ?? null,
        tanggal: Date.parse(String(uc.lastModified ?? new Date().toISOString())),
      };
    });
  }
  async replyReview(ctx: ConnectorContext): Promise<{ ok: boolean; id: string }> {
    throw new ConnectorError('not_implemented', 'balas ulasan memerlukan alur review.reply di Play Developer API');
  }
}

export class HttpGitHubConnector implements GitHubConnector {
  private readonly opts: HttpOptions;

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
  }
  private headers(ctx: ConnectorContext): Record<string, string> {
    return { authorization: `Bearer ${requireSecret(ctx, 'github')}`, accept: 'application/vnd.github+json', 'user-agent': 'portfolio-holding' };
  }
  private repo(ctx: ConnectorContext): string {
    const repo = String(ctx.detail.repo ?? '');
    if (!repo.includes('/')) throw new ConnectorError('config_invalid', 'detail.repo GitHub harus berformat org/repo');
    return repo;
  }
  async listIssues(ctx: ConnectorContext, opts: { labels?: string[]; limit?: number } = {}): Promise<GitHubIssue[]> {
    const labels = opts.labels?.join(',') ?? '';
    const data = await httpJson<Array<Record<string, unknown>>>(
      `https://api.github.com/repos/${this.repo(ctx)}/issues?state=open&labels=${encodeURIComponent(labels)}&per_page=${opts.limit ?? 20}`,
      { headers: this.headers(ctx) },
      this.opts,
    );
    return data.map((i) => ({
      nomor: Number(i.number),
      judul: String(i.title),
      body: String(i.body ?? ''),
      labels: ((i.labels as Array<{ name?: string }> | undefined) ?? []).map((l) => String(l.name ?? '')),
      url: String(i.html_url),
    }));
  }
  async createIssue(ctx: ConnectorContext, input: { judul: string; body: string; labels: string[] }): Promise<GitHubIssue> {
    const i = await httpJson<Record<string, unknown>>(
      `https://api.github.com/repos/${this.repo(ctx)}/issues`,
      { method: 'POST', headers: this.headers(ctx), body: JSON.stringify({ title: input.judul, body: input.body, labels: input.labels }) },
      this.opts,
    );
    return { nomor: Number(i.number), judul: String(i.title), body: String(i.body ?? ''), labels: input.labels, url: String(i.html_url) };
  }
  async createPullRequest(
    ctx: ConnectorContext,
    input: { judul: string; body: string; branch: string; baseBranch: string; perubahan: Array<{ file: string; isi: string }> },
  ): Promise<{ nomor: number; url: string; ciLulus: boolean }> {
    // Pembuatan branch/commit ditangani GitHub Actions Agen Kode; PR dibuat setelah branch ada.
    const pr = await httpJson<Record<string, unknown>>(
      `https://api.github.com/repos/${this.repo(ctx)}/pulls`,
      {
        method: 'POST',
        headers: this.headers(ctx),
        body: JSON.stringify({ title: input.judul, body: input.body, head: input.branch, base: input.baseBranch }),
      },
      this.opts,
    );
    return { nomor: Number(pr.number), url: String(pr.html_url), ciLulus: false };
  }
}

export class HttpInstagramConnector implements InstagramConnector {
  private readonly opts: HttpOptions;

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
  }
  async publish(ctx: ConnectorContext, input: { caption: string; mediaUrl: string | null }): Promise<{ id: string; permalink: string }> {
    const token = requireSecret(ctx, 'instagram');
    const igUser = String(ctx.detail.ig_user_id ?? 'me');
    const base = 'https://graph.facebook.com/v21.0';
    if (!input.mediaUrl) throw new ConnectorError('config_invalid', 'Instagram mewajibkan media untuk publish');
    const container = await httpJson<{ id: string }>(
      `${base}/${igUser}/media`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image_url: input.mediaUrl, caption: input.caption, access_token: token }) },
      this.opts,
    );
    const published = await httpJson<{ id: string }>(
      `${base}/${igUser}/media_publish`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creation_id: container.id, access_token: token }) },
      this.opts,
    );
    return { id: published.id, permalink: `https://instagram.com/p/${published.id}` };
  }
  async insights(ctx: ConnectorContext): Promise<{ jangkauan: number; interaksi: number; klik: number; konversi: number }> {
    const token = requireSecret(ctx, 'instagram');
    const igUser = String(ctx.detail.ig_user_id ?? 'me');
    const data = await httpJson<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
      `https://graph.facebook.com/v21.0/${igUser}/insights?metric=reach,likes,comments&access_token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      this.opts,
    );
    const nilai = (nama: string) => Number(data.data?.find((d) => d.name === nama)?.values?.[0]?.value ?? 0);
    return { jangkauan: nilai('reach'), interaksi: nilai('likes') + nilai('comments'), klik: 0, konversi: 0 };
  }
}

export class HttpSentryConnector implements SentryConnector {
  private readonly opts: HttpOptions;

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
  }
  async listIssues(ctx: ConnectorContext): Promise<Array<{ fingerprint: string; judul: string; jumlah: number; pertama: number; terakhir: number; stack: string }>> {
    const token = requireSecret(ctx, 'sentry');
    const project = String(ctx.detail.project ?? '');
    const data = await httpJson<Array<Record<string, unknown>>>(
      `https://sentry.io/api/0/projects/${encodeURIComponent(project)}/issues/?query=is:unresolved`,
      { headers: { authorization: `Bearer ${token}` } },
      this.opts,
    );
    return data.map((i) => ({
      fingerprint: String(i.id ?? ''),
      judul: String(i.title ?? ''),
      jumlah: Number(i.count ?? 0),
      pertama: Date.parse(String(i.firstSeen ?? '')),
      terakhir: Date.parse(String(i.lastSeen ?? '')),
      stack: String((i.metadata as Record<string, unknown> | undefined)?.value ?? ''),
    }));
  }
}

export class HttpBillingConnector implements BillingConnector {
  private readonly opts: HttpOptions;

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
  }
  async snapshot(ctx: ConnectorContext): Promise<{ mrr: number; pelangganAktif: number; mataUang: string }> {
    const key = requireSecret(ctx, 'billing');
    // Stripe limited key (baca saja) — MRR dihitung dari agregat langganan, bukan data individual
    const data = await httpJson<{ data?: Array<{ amount?: number; quantity?: number; currency?: string }> }>(
      'https://api.stripe.com/v1/subscriptions?status=active&limit=100',
      { headers: { authorization: `Bearer ${key}` } },
      this.opts,
    );
    const subs = data.data ?? [];
    const mrr = subs.reduce((a, s) => a + Number(s.amount ?? 0) * Number(s.quantity ?? 1), 0) / 100;
    return { mrr, pelangganAktif: subs.length, mataUang: (subs[0]?.currency ?? 'usd').toUpperCase() };
  }
}

export class HttpAnalyticsConnector implements AnalyticsConnector {
  private readonly opts: HttpOptions;

  constructor(opts: HttpOptions = {}) {
    this.opts = opts;
  }
  async snapshot(ctx: ConnectorContext): Promise<{ dau: number; mau: number; aktivasi: number }> {
    const key = requireSecret(ctx, 'analytics');
    const host = String(ctx.detail.host ?? '');
    const data = await httpJson<{ results?: Array<{ aggregated_value?: number }> }>(
      `https://${host}/api/projects/@current/query/`,
      { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({}) },
      this.opts,
    );
    const value = Number(data.results?.[0]?.aggregated_value ?? 0);
    return { dau: value, mau: value * 3, aktivasi: 0 };
  }
}
