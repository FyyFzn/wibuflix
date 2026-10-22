import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Play, Trash2, RefreshCw, Film } from 'lucide-react';
import {
  getRiwayat,
  hapusRiwayat,
  clearAllHistory,
  syncHistoryWithCloud,
  formatWaktuYangLalu,
  formatDuration
} from '../services/storage';
import { WatchHistoryItem } from '../types';

export default function HistoryPage() {
  const [history, setHistory] = useState<WatchHistoryItem[]>([]);
  const [syncing, setSyncing] = useState(false);

  const loadHistory = useCallback(() => {
    setHistory(getRiwayat());
  }, []);

  const handleSyncCloud = async () => {
    setSyncing(true);
    try {
      const merged = await syncHistoryWithCloud();
      setHistory(merged);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    loadHistory();
    // Reconcile with cloud in background on mount
    handleSyncCloud();
  }, [loadHistory]);

  const handleDeleteItem = async (e: React.MouseEvent, item: WatchHistoryItem) => {
    e.preventDefault();
    e.stopPropagation();
    const identifier = item.seriUrl || item.judulSeri || item.url;
    await hapusRiwayat(identifier);
    loadHistory();
  };

  const handleClearAll = async () => {
    if (!confirm('Yakin ingin menghapus seluruh riwayat tontonan?')) return;
    await clearAllHistory();
    setHistory([]);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-white/5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Clock className="w-6 h-6 text-accent" />
            <h1 className="text-2xl font-bold text-white tracking-tight">Riwayat Tontonan</h1>
          </div>
          <p className="text-xs text-gray-400">
            Daftar anime dan episode terakhir yang Anda tonton di Wibuflix.
          </p>
        </div>

        {history.length > 0 && (
          <div className="flex items-center gap-3">
            <button
              disabled={syncing}
              onClick={handleSyncCloud}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-surface hover:bg-white/10 text-xs font-semibold text-gray-300 hover:text-white border border-white/10 transition-colors disabled:opacity-40"
              title="Sinkronisasi dengan Cloud"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-accent ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Sinkronisasi...' : 'Sinkron Cloud'}</span>
            </button>

            <button
              onClick={handleClearAll}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-xs font-semibold text-red-400 hover:text-red-300 border border-red-500/20 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Hapus Semua</span>
            </button>
          </div>
        )}
      </div>

      {/* Main Content */}
      {history.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-4 text-center text-gray-400 bg-surface/30 rounded-2xl border border-white/5 p-8">
          <Film className="w-12 h-12 text-gray-600 mb-1" />
          <div className="space-y-1">
            <p className="text-base font-semibold text-white">Belum Ada Riwayat Tontonan</p>
            <p className="text-xs max-w-sm">
              Semua anime yang Anda tonton akan otomatis tercatat di sini dan disinkronkan ke cloud.
            </p>
          </div>
          <Link
            to="/katalog"
            className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-bold shadow-lg shadow-accent/20 transition-all"
          >
            Mulai Menonton Sekarang
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {history.map((item, idx) => {
            const percent = item.duration && item.duration > 0
              ? Math.min(100, Math.round((item.progress / item.duration) * 100))
              : 0;

            const playerUrl = `/player?url=${encodeURIComponent(item.url)}&seriUrl=${encodeURIComponent(item.seriUrl || '')}&seriJudul=${encodeURIComponent(item.judulSeri)}&judul=${encodeURIComponent(item.judulSeri)}&gambar=${encodeURIComponent(item.gambar || '')}`;

            return (
              <div
                key={item.url || idx}
                className="group relative flex gap-4 p-3.5 rounded-2xl bg-card border border-white/5 hover:border-accent/40 hover:bg-surface transition-all shadow-sm"
              >
                {/* Poster with Progress Overlay */}
                <Link
                  to={playerUrl}
                  className="relative w-24 sm:w-28 aspect-[3/4] rounded-xl overflow-hidden bg-surface shrink-0 block"
                >
                  <img
                    src={item.gambar || 'https://via.placeholder.com/200x300/181926/888888?text=Wibuflix'}
                    alt={item.judulSeri}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />

                  {/* Play icon overlay on hover */}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center shadow">
                      <Play className="w-4 h-4 fill-white ml-0.5" />
                    </div>
                  </div>

                  {/* Progress bar */}
                  {percent > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/60">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  )}
                </Link>

                {/* Info and Actions */}
                <div className="flex flex-col flex-1 justify-between py-0.5 overflow-hidden">
                  <div className="space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        to={playerUrl}
                        className="text-sm font-semibold text-white group-hover:text-accent transition-colors line-clamp-2 leading-snug"
                        title={item.judulSeri}
                      >
                        {item.judulSeri}
                      </Link>

                      <button
                        onClick={(e) => handleDeleteItem(e, item)}
                        className="p-1 text-gray-500 hover:text-red-400 transition-colors shrink-0"
                        title="Hapus dari Riwayat"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      {item.nomorEp && (
                        <span className="font-semibold text-accent">
                          Ep {item.nomorEp}
                        </span>
                      )}
                      <span>•</span>
                      <span>{formatWaktuYangLalu(item.waktu)}</span>
                    </div>

                    {item.duration > 0 && (
                      <div className="text-[11px] text-gray-500 font-mono">
                        {formatDuration(item.progress)} / {formatDuration(item.duration)} ({percent}%)
                      </div>
                    )}
                  </div>

                  <div className="pt-2 flex items-center justify-between">
                    <Link
                      to={playerUrl}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/15 hover:bg-accent text-accent hover:text-white text-xs font-semibold transition-colors"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Lanjutkan</span>
                    </Link>

                    {item.seriUrl && (
                      <Link
                        to={`/detail/${encodeURIComponent(item.seriUrl)}`}
                        className="text-[11px] text-gray-400 hover:text-white transition-colors"
                      >
                        Detail &rarr;
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
