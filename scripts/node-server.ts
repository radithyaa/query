/**
 * Server HTTP lokal (§3.4 lingkungan Lokal): Hono `app.fetch` dilayani lewat
 * `node:http` dengan SQLite lokal, konektor mock, dan model deterministik.
 * Tidak ada dependensi tambahan; cukup `npm start`.
 *
 * Endpoint tambahan hanya untuk lokal:
 *   POST /api/v1/login  { email?, role? } → token HS256 agar dashboard/API dapat dicoba.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { signHs256, type Claims } from '../apps/api/src/auth.ts';
import { buildApp } from '../apps/api/src/app.ts';
import { apiContext } from '../apps/api/src/context.ts';
import { arg, bukaAplikasi, dbPath, flag, loadDotEnv } from './lib.ts';
import { serveAssetAtauSpa } from './http-static.ts';

loadDotEnv();
const port = Number(arg('port') ?? process.env['PORT'] ?? 8787);
const host = arg('host') ?? process.env['HOST'] ?? '127.0.0.1';

const app = await bukaAplikasi({ path: dbPath() });
const { bindings, ctx } = app;
if (flag('seed')) {
  const unit = await ctx.repos.saas.count();
  if (unit === 0) {
    console.log(JSON.stringify({ level: 'info', msg: 'server.seed_belum_ada', tips: 'jalankan npm run seed lalu nyalakan ulang' }));
  }
}

const hono = buildApp();
const secret = bindings.JWT_SECRET ?? 'dev-only-secret-change-me-please';

function headers(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(', '));
  }
  if (!h.has('x-forwarded-proto')) h.set('x-forwarded-proto', 'http');
  if (!h.has('host')) h.set('host', `${host}:${port}`);
  return h;
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const url = `http://${headers(req).get('host')}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';
  const init: RequestInit = { method, headers: headers(req) };
  if (body && method !== 'GET' && method !== 'HEAD') init.body = new Uint8Array(body);
  return new Request(url, init);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/** Token pengembangan: HS256 dengan klaim peran; bukan untuk produksi. */
async function handleLogin(req: Request): Promise<Response> {
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string; saas?: string[] };
    const role = body.role === 'operator' || body.role === 'service' ? body.role : 'owner';
    const claims: Omit<Claims, 'exp' | 'iat'> = {
      sub: body.email ?? `${role}@lokal`,
      role,
      saas: body.saas ?? [],
      ...(body.email ? { email: body.email } : { email: `${role}@lokal` }),
      ...(role === 'owner' ? { mfa: true } : {}),
    };
    const nowDetik = Math.floor(Date.now() / 1000);
    const token = await signHs256({ ...claims, iat: nowDetik, exp: nowDetik + 8 * 3600 }, secret);
    return Response.json({ data: { token, role, ttl_detik: 8 * 3600, tips: `kirim sebagai Authorization: Bearer <token>` } });
  }
  return Response.json({ error: { kode: 'body_bukan_json', pesan: 'kirim {"email":"...","role":"owner|operator"}' } }, { status: 400 });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  void (async () => {
    try {
      if (url.pathname === '/api/v1/login' && req.method === 'POST') {
        await send(res, await handleLogin(await toRequest(req)));
        return;
      }
      // Aset dashboard hasil build (apps/web/dist) → fallback SPA untuk rute halaman.
      // Path `/api/*` yang tidak dikenal tetap diteruskan ke Hono (404 JSON).
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
        const asset = await serveAssetAtauSpa(url.pathname);
        if (asset) {
          await send(res, asset);
          return;
        }
      }
      await send(res, await hono.fetch(await toRequest(req), bindings));
    } catch (error) {
      const pesan = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(pesan);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
      }
      res.end(JSON.stringify({ error: { kode: 'internal_error', pesan: 'kesalahan server' } }));
    }
  })();
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'server.siap',
      url: `http://${host}:${port}`,
      dashboard: `http://${host}:${port}/`,
      viteDev: `npm run dev:web (meneruskan /api ke ${port})`,
      db: dbPath(),
      mock: bindings.MOCK_CONNECTORS !== 'false',
      tips: `POST /api/v1/login {"role":"owner"} untuk token pengembangan`,
    }),
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', msg: 'server.berhenti', signal }));
  server.close(() => {
    app.db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
