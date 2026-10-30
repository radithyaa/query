/**
 * Siklus harian manual (FR-7.7: "boleh hanya API; di produksi dipicu Cron").
 * Form ini tetap disediakan untuk pengujian lokal/staging dengan label jelas.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { panggil } from '../lib/api';
import { Badge, Field, Galat, Input, Switch, Tombol, useToast } from './ui';

interface HasilSiklus {
  tanggal: string;
  evaluations: Array<{ saasId: string; skor: number; dari: string; ke: string; alasan: string }>;
  jobsQueued: string[];
  jobsSkipped: string[];
  jobs: Array<{ id: string; fungsi: string; jenis: string; status: string; approvalId: string | null; alasan: string }>;
  reports: unknown[];
}

export function JalankanSiklus({ onSelesai }: { onSelesai?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [tanggal, setTanggal] = useState('');
  const [skipJobs, setSkipJobs] = useState(false);
  const [galat, setGalat] = useState<unknown>(null);
  const [hasil, setHasil] = useState<HasilSiklus | null>(null);

  const jalankan = useMutation({
    mutationFn: () =>
      panggil<{ data: HasilSiklus }>('/cycle', {
        method: 'POST',
        body: { ...(tanggal ? { tanggal } : {}), skip_jobs: skipJobs },
      }),
    onSuccess: async (res) => {
      setHasil(res.data);
      setGalat(null);
      toast.sukses(`Siklus ${res.data.tanggal} selesai: ${res.data.jobsQueued.length} job baru, ${res.data.reports.length} laporan.`);
      await Promise.all(
        ['summary', 'status', 'approvals', 'sunset', 'unit', 'laporan', 'audit', 'ops'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
      );
      onSelesai?.();
    },
    onError: (error) => setGalat(error),
  });

  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted">
        Menjalankan: pemulihan job macet → ingest metrik → penjadwalan job agen → evaluasi Health → konsumsi antrean →
        laporan Agen Induk. Idempoten per tanggal, jadi aman diulang.
      </p>
      <Field label="Tanggal (opsional)" hint="Kosongkan untuk hari ini (UTC).">
        {(id) => <Input id={id} type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />}
      </Field>
      <Switch
        checked={skipJobs}
        onChange={setSkipJobs}
        label="Lewati eksekusi job agen"
        deskripsi="Hanya jadwalkan job dan evaluasi Health (tidak memanggil model)."
      />
      {galat ? <Galat error={galat} /> : null}
      {hasil ? (
        <div className="grid gap-1 rounded-md bg-surface-2 p-2 text-xs">
          <p>
            <strong>{hasil.tanggal}</strong> · {hasil.evaluations.length} evaluasi · {hasil.jobsQueued.length} job baru ·{' '}
            {hasil.jobs.length} job dijalankan · {hasil.reports.length} laporan
          </p>
          <ul className="grid gap-0.5">
            {hasil.jobs.slice(0, 8).map((j) => (
              <li key={j.id} className="flex flex-wrap gap-2">
                <Badge nada={j.status === 'done' ? 'ok' : j.status === 'awaiting_approval' ? 'warn' : j.status === 'dead' ? 'bad' : 'netral'}>
                  {j.status}
                </Badge>
                <span>{j.fungsi}</span>
                <span className="text-muted">{j.jenis}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Tombol varian="utama" onClick={() => jalankan.mutate()} memuat={jalankan.isPending}>
          <RefreshCw className="size-4" aria-hidden="true" /> Jalankan siklus
        </Tombol>
      </div>
    </div>
  );
}
