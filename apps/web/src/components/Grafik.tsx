/**
 * Grafik garis SVG tanpa dependensi chart library (NFR-9: bundle ringan).
 * Mendukung batas nilai eksplisit supaya seri MRR dan Health Score dapat
 * ditumpuk pada skala yang wajar.
 */
import { useId } from 'react';

export interface TitikSeri {
  label: string;
  nilai: number | null;
}

export function GrafikGaris({
  seri,
  tinggi = 140,
  lebar = 640,
  satuan = '',
  warna = 'var(--c-accent)',
  nama,
  minEksplisit,
  maxEksplisit,
}: {
  seri: TitikSeri[];
  tinggi?: number;
  lebar?: number;
  satuan?: string;
  warna?: string;
  nama: string;
  minEksplisit?: number;
  maxEksplisit?: number;
}) {
  const id = useId();
  const titik = seri.filter((t): t is { label: string; nilai: number } => t.nilai !== null && Number.isFinite(t.nilai));
  if (titik.length === 0) {
    return (
      <p className="px-4 py-6 text-xs text-muted" role="status">
        Belum ada data untuk digambar.
      </p>
    );
  }

  const pad = { kiri: 44, kanan: 8, atas: 10, bawah: 20 };
  const lebarGambar = Math.max(120, lebar - pad.kiri - pad.kanan);
  const tinggiGambar = Math.max(60, tinggi - pad.atas - pad.bawah);
  const nilai = titik.map((t) => t.nilai);
  const min = minEksplisit ?? Math.min(...nilai);
  const max = maxEksplisit ?? Math.max(...nilai);
  const rentang = max - min || 1;

  const x = (i: number) => pad.kiri + (titik.length === 1 ? lebarGambar / 2 : (i / (titik.length - 1)) * lebarGambar);
  const y = (v: number) => pad.atas + tinggiGambar - ((v - min) / rentang) * tinggiGambar;

  const jalur = titik.map((t, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(t.nilai).toFixed(1)}`).join(' ');
  const area = `${jalur} L${x(titik.length - 1).toFixed(1)},${(pad.atas + tinggiGambar).toFixed(1)} L${x(0).toFixed(1)},${(pad.atas + tinggiGambar).toFixed(1)} Z`;

  const garis = [0, 0.5, 1].map((p) => min + p * rentang);
  const format = (v: number) =>
    Math.abs(v) >= 1000 ? new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(v);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${lebar} ${tinggi}`}
        role="img"
        aria-label={`${nama}: ${titik.length} titik, terakhir ${format(titik[titik.length - 1]!.nilai)}${satuan}`}
        className="h-auto w-full"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={warna} stopOpacity="0.22" />
            <stop offset="100%" stopColor={warna} stopOpacity="0" />
          </linearGradient>
        </defs>
        {garis.map((v, i) => (
          <g key={i}>
            <line x1={pad.kiri} x2={lebar - pad.kanan} y1={y(v)} y2={y(v)} stroke="var(--c-line)" strokeDasharray={i === 0 ? undefined : '3 4'} />
            <text x={pad.kiri - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--c-muted)">
              {format(v)}
            </text>
          </g>
        ))}
        <path d={area} fill={`url(#grad-${id})`} />
        <path d={jalur} fill="none" stroke={warna} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {titik.map((t, i) => (
          <circle key={t.label} cx={x(i)} cy={y(t.nilai)} r={i === titik.length - 1 ? 3 : 1.8} fill={warna}>
            <title>{`${t.label}: ${format(t.nilai)}${satuan}`}</title>
          </circle>
        ))}
        <text x={pad.kiri} y={tinggi - 4} fontSize="9" fill="var(--c-muted)">
          {titik[0]!.label}
        </text>
        <text x={lebar - pad.kanan} y={tinggi - 4} fontSize="9" fill="var(--c-muted)" textAnchor="end">
          {titik[titik.length - 1]!.label}
        </text>
      </svg>
      <figcaption className="px-1 text-[11px] text-muted">
        {titik.length} titik · terakhir {format(titik[titik.length - 1]!.nilai)}
        {satuan}
      </figcaption>
    </figure>
  );
}
