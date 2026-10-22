import { useState, useEffect, useCallback } from 'react';
import { Layers, ArrowUpCircle, XCircle, RefreshCw, Radio } from 'lucide-react';
import { API_BASE, fetchQueueStatus, queuePrioritize, queueCancel } from '../services/api';
import { QueueItem } from '../types';

export default function QueuePage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadInitial = useCallback(async () => {
    try {
      const res = await fetchQueueStatus();
      if (res && res.queue) {
        setQueue(res.queue);
      }
    } catch (err: any) {
      setError(err?.message || 'Gagal memuat status antrean');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitial();

    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API_BASE}/api/queue/stream`);

      es.onopen = () => {
        setConnected(true);
      };

      es.onmessage = (event) => {
        if (!event.data) return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.success && parsed.queue) {
            setQueue(parsed.queue);
          }
        } catch {}
      };

      es.onerror = () => {
        setConnected(false);
      };
    } catch {
      setConnected(false);
    }

    return () => {
      if (es) {
        es.close();
      }
    };
  }, [loadInitial]);

  const handlePrioritize = async (id: string) => {
    setActionLoading(id);
    try {
      await queuePrioritize(id);
      loadInitial();
    } catch (err: any) {
      alert(`Gagal memprioritaskan antrean: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Yakin ingin membatalkan tugas transcoding ini?')) return;
    setActionLoading(id);
    try {
      await queueCancel(id);
      loadInitial();
    } catch (err: any) {
      alert(`Gagal membatalkan antrean: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = (status: QueueItem['status']) => {
    switch (status) {
      case 'UPLOADING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Transcoding / Uploading
          </span>
        );
      case 'PENDING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            Menunggu Antrean
          </span>
        );
      case 'COMPLETED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Selesai
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            Gagal
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-500/15 text-gray-400 border border-gray-500/30">
            Dibatalkan
          </span>
        );
      default:
        return <span className="text-xs text-gray-400">{status}</span>;
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header and Live indicator */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-white/5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Layers className="w-6 h-6 text-accent" />
            <h1 className="text-2xl font-bold text-white tracking-tight">Antrean Transcoding HLS</h1>
          </div>
          <p className="text-xs text-gray-400">
            Pantau proses konversi segmen video dan unggahan ke Azure Blob Storage secara real-time.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface border border-white/10 text-xs">
            <Radio className={`w-3.5 h-3.5 ${connected ? 'text-emerald-400 animate-pulse' : 'text-gray-500'}`} />
            <span className={connected ? 'text-emerald-400 font-medium' : 'text-gray-400'}>
              {connected ? 'Live Stream Aktif' : 'Polling'}
            </span>
          </div>

          <button
            onClick={() => loadInitial()}
            className="p-2 rounded-xl bg-surface hover:bg-white/10 border border-white/10 text-gray-300 hover:text-white transition-colors"
            title="Muat Ulang"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      {loading ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3">
          <RefreshCw className="w-8 h-8 text-accent animate-spin" />
          <p className="text-xs text-gray-400">Menghubungkan ke monitor antrean...</p>
        </div>
      ) : error ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={loadInitial}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-semibold rounded-xl"
          >
            Coba Lagi
          </button>
        </div>
      ) : queue.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-2 text-center text-gray-400 bg-surface/30 rounded-2xl border border-white/5 p-8">
          <Layers className="w-10 h-10 text-gray-600 mb-2" />
          <p className="text-base font-semibold text-white">Antrean Saat Ini Kosong</p>
          <p className="text-xs max-w-sm">
            Tidak ada tugas transcoding yang sedang berjalan. Antrean akan terisi saat pengguna menonton video baru.
          </p>
        </div>
      ) : (
        <div className="bg-surface rounded-2xl border border-white/10 overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-card text-xs font-semibold text-gray-400 border-b border-white/5 uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Anime / Episode</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Progress</th>
                  <th className="px-5 py-3.5">Waktu</th>
                  <th className="px-5 py-3.5 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {queue.map((item) => (
                  <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        {item.cover && (
                          <img
                            src={item.cover}
                            alt={item.seriesTitle}
                            className="w-10 h-14 object-cover rounded-lg shrink-0 bg-card"
                          />
                        )}
                        <div>
                          <div className="font-semibold text-white line-clamp-1">{item.seriesTitle || item.seriesSlug}</div>
                          <div className="text-xs text-gray-400 line-clamp-1">{item.episodeTitle || item.episodeUrl}</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap">
                      {getStatusBadge(item.status)}
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap text-xs text-gray-300">
                      {item.progress ? (
                        <div className="space-y-1">
                          <span className="font-mono text-accent font-semibold">{item.progress}</span>
                        </div>
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap text-xs text-gray-400">
                      {item.createdAt ? new Date(item.createdAt).toLocaleTimeString('id-ID') : '-'}
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-2">
                        {item.status === 'PENDING' && (
                          <button
                            disabled={actionLoading === item.id}
                            onClick={() => handlePrioritize(item.id)}
                            className="p-1.5 rounded-lg bg-surface hover:bg-white/10 text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-40"
                            title="Prioritaskan Tugas"
                          >
                            <ArrowUpCircle className="w-4 h-4" />
                          </button>
                        )}
                        {(item.status === 'PENDING' || item.status === 'UPLOADING') && (
                          <button
                            disabled={actionLoading === item.id}
                            onClick={() => handleCancel(item.id)}
                            className="p-1.5 rounded-lg bg-surface hover:bg-white/10 text-red-400 hover:text-red-300 transition-colors disabled:opacity-40"
                            title="Batalkan Tugas"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
