/**
 * Registry konektor: memilih implementasi mock (lokal/staging) atau HTTP (produksi)
 * berdasarkan mode lingkungan. Inti sistem tidak bergantung pada detail platform.
 */
import { MockAnalytics, MockBilling, MockGitHub, MockInstagram, MockPlay, MockSentry, createMockConnectors } from './mock.ts';
import { HttpAnalyticsConnector, HttpBillingConnector, HttpGitHubConnector, HttpInstagramConnector, HttpPlayConnector, HttpSentryConnector } from './http.ts';
import type { ConnectorSet } from './types.ts';

export interface ConnectorOptions {
  mode?: 'mock' | 'http';
  fetch?: typeof fetch;
}

export function createConnectors(opts: ConnectorOptions = {}): ConnectorSet {
  if ((opts.mode ?? 'mock') === 'mock') return createMockConnectors();
  const httpOpts = opts.fetch ? { fetch: opts.fetch } : {};
  return {
    play: new HttpPlayConnector(httpOpts),
    github: new HttpGitHubConnector(httpOpts),
    instagram: new HttpInstagramConnector(httpOpts),
    sentry: new HttpSentryConnector(httpOpts),
    billing: new HttpBillingConnector(httpOpts),
    analytics: new HttpAnalyticsConnector(httpOpts),
  };
}

export { MockPlay, MockGitHub, MockInstagram, MockSentry, MockBilling, MockAnalytics };
