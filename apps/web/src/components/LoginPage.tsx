/**
 * Gerbang login. Di produksi cloudflared Access mengisi cookie `CF_Authorization`
 * sehingga dashboard terbuka tanpa aksi; token manual/tombol token lokal hanya
 * untuk pengembangan (NFR-5: autentikasi kuat + peran).
 */
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, sesiDariToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Card, Field, Input, Tombol } from '../components/ui';

export function LoginPage() {
  const { masuk } = useAuth();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [galat, setGalat] = useState<string | null>(null);
  const [memuat, setMemuat] = useState(false);
  const [lokal, setLokal] = useState<{ tersedia: boolean } | null>(null);

  function cobaMasuk(nilai: string) {
    const sesi = masuk(nilai);
    if (!sesi) {
      setGalat('Token tidak valid, kedaluwarsa, atau bukan peran owner/operator.');
      return false;
    }
    void qc.invalidateQueries();
    return true;
  }

  async function tokenLokal(role: 'owner' | 'operator') {
    setMemuat(true);
    setGalat(null);
    try {
      const { data } = await api.loginDev(role);
      cobaMasuk(data.token);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) setLokal({ tersedia: false });
      else setGalat(error instanceof Error ? error.message : String(error));
    } finally {
      setMemuat(false);
    }
  }

  const klaim = token ? sesiDariToken(token) : null;

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center gap-5 px-5 py-10">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold text-fg">Portofolio SaaS</h1>
        <p className="text-sm text-muted">
          Dashboard Agen Induk. Masuk dengan akun pemilik atau operator yang memiliki akses ke portofolio.
        </p>
      </header>

      <Card className="p-4">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setGalat(null);
            cobaMasuk(token);
          }}
        >
          <Field
            label="Token akses (Bearer)"
            hint={klaim ? `Terbaca: peran ${klaim.role}, berlaku sampai ${new Date(klaim.exp * 1000).toLocaleString('id-ID')}.` : 'Dapatkan token dari penyedia identitas atau, di lingkungan lokal, dari tombol di bawah.'}
            galat={galat}
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="eyJhbGciOi…"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setGalat(null);
                }}
              />
            )}
          </Field>
          <Tombol type="submit" varian="utama" disabled={!token.trim()}>
            <KeyRound className="size-4" aria-hidden="true" /> Masuk
          </Tombol>
        </form>
      </Card>

      <Card className="p-4">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
          <div className="grid gap-2">
            <p className="text-xs text-muted">
              Produksi memakai Cloudflare Access (SSO + MFA). Tombol di bawah menerbitkan token pengembangan HS256 dari{' '}
              <code>scripts/node-server.ts</code> dan tidak tersedia saat di-deploy.
            </p>
            <div className="flex flex-wrap gap-2">
              <Tombol ukuran="sm" onClick={() => void tokenLokal('owner')} memuat={memuat}>
                Token lokal: pemilik
              </Tombol>
              <Tombol ukuran="sm" onClick={() => void tokenLokal('operator')} memuat={memuat}>
                Token lokal: operator
              </Tombol>
            </div>
            {lokal?.tersedia === false ? (
              <Badge nada="netral">Endpoint login lokal tidak tersedia di lingkungan ini</Badge>
            ) : null}
          </div>
        </div>
      </Card>
    </main>
  );
}
