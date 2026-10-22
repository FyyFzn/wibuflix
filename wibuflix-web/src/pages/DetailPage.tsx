import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Star, Play, Search, ArrowUpDown, RefreshCw, Film, Clock } from 'lucide-react';
import { fetchEpisodes } from '../services/api';
import { getRiwayat, formatDuration } from '../services/storage';
import { EpisodesResponse, EpisodeItem, WatchHistoryItem } from '../types';

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const decodedUrl = id ? decodeURIComponent(id) : '';

  const [data, setData] = useState<EpisodesResponse['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const [lastWatched, setLastWatched] = useState<WatchHistoryItem | null>(null);

  const loadData = useCallback(async () => {
    if (!decodedUrl) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchEpisodes(decodedUrl);
      if (res && res.data) {
        setData(res.data);
      }
    } catch (err: any) {
      setError(err?.message || 'Gagal memuat detail anime');
    } finally {
      setLoading(false);
    }
  }, [decodedUrl]);

  useEffect(() => {
    loadData();

    // Check watch history for this series
    const riwayat = getRiwayat();
    const found = riwayat.find(r => r.seriUrl === decodedUrl || (data?.judul_seri && r.judulSeri.toLowerCase() === data.judul_seri.toLowerCase()));
    if (found) {
      setLastWatched(found);
    }
  }, [loadData, decodedUrl, data?.judul_seri]);

  const episodes = data?.daftar_episode || [];
  const mal = data?.mal;

  const filteredEpisodes = useMemo(() => {
    let list = [...episodes];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e => e.judul?.toLowerCase().includes(q) || (e.title && e.title.toLowerCase().includes(q)));
    }
    if (sortOrder === 'asc') {
      list = [...list].reverse();
    }
    return list;
  }, [episodes, searchQuery, sortOrder]);

  const getPrimaryEpisodeUrl = (ep: EpisodeItem): string => {
    if (ep.url) return ep.url;
    if (Array.isArray(ep.urls) && ep.urls.length > 0) return ep.urls[0];
    if (ep.urls && typeof ep.urls === 'object') {
      const first = Object.values(ep.urls)[0];
      if (first) return first;
    }
    return '';
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center gap-3">
        <RefreshCw className="w-8 h-8 text-accent animate-spin" />
        <p className="text-xs text-gray-400">Memuat detail & daftar episode...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-red-400 text-sm font-medium">{error || 'Anime tidak ditemukan'}</p>
        <button
          onClick={loadData}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-semibold rounded-xl"
        >
          Coba Lagi
        </button>
      </div>
    );
  }

  const cover = mal?.cover || data.cover_scraper || '';
  const synopsis = mal?.synopsis || 'Sinopsis belum tersedia untuk anime ini.';

  return (
    <div className="space-y-10 pb-16">
      {/* Anime Header Hero */}
      <section className="relative w-full bg-surface border-b border-white/5 overflow-hidden">
        {/* Background Backdrop Blur */}
        <div className="absolute inset-0">
          <img
            src={cover}
            alt={data.judul_seri}
            className="w-full h-full object-cover filter blur-2xl opacity-20 scale-125"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-surface/80 to-transparent" />
        </div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-14">
          <div className="flex flex-col md:flex-row gap-8 items-start">
            {/* Poster Card */}
            <div className="w-48 sm:w-56 md:w-64 aspect-[3/4] rounded-2xl overflow-hidden bg-card border border-white/10 shadow-2xl shrink-0 mx-auto md:mx-0">
              <img
                src={cover}
                alt={data.judul_seri}
                className="w-full h-full object-cover"
              />
            </div>

            {/* Info details */}
            <div className="flex-1 space-y-4 text-center md:text-left">
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2">
                {mal?.malScore && (
                  <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-400 text-xs font-bold">
                    <Star className="w-3.5 h-3.5 fill-amber-400" />
                    <span>MAL {mal.malScore}</span>
                  </span>
                )}
                {mal?.status && (
                  <span className="px-3 py-1 rounded-full bg-surface text-gray-300 text-xs font-semibold border border-white/10">
                    {mal.status}
                  </span>
                )}
                {mal?.episodes && (
                  <span className="px-3 py-1 rounded-full bg-surface text-gray-300 text-xs font-semibold border border-white/10">
                    {mal.episodes} Episode
                  </span>
                )}
              </div>

              <h1 className="text-2xl sm:text-3xl md:text-4xl font-black text-white tracking-tight">
                {data.judul_seri}
              </h1>

              {/* Genre Badges */}
              {mal?.genres && mal.genres.length > 0 && (
                <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 pt-1">
                  {mal.genres.map((g) => (
                    <span
                      key={g}
                      className="px-2.5 py-1 rounded-lg bg-card text-gray-400 text-xs font-medium border border-white/5"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              )}

              {/* Synopsis */}
              <div className="pt-2 text-sm text-gray-300 leading-relaxed max-w-3xl">
                <p className={synopsisExpanded ? '' : 'line-clamp-3'}>
                  {synopsis}
                </p>
                {synopsis.length > 180 && (
                  <button
                    onClick={() => setSynopsisExpanded(!synopsisExpanded)}
                    className="text-xs text-accent font-semibold hover:underline mt-1.5 inline-block"
                  >
                    {synopsisExpanded ? 'Sembunyikan' : 'Baca Selengkapnya...'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Lanjutkan Nonton Banner (if in watch history) */}
        {lastWatched && (
          <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-accent/20 via-card to-card border border-accent/40 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-xl shadow-accent/5">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-xl bg-accent text-white">
                <Play className="w-5 h-5 fill-white" />
              </div>
              <div>
                <span className="text-xs font-bold text-accent uppercase tracking-wider">Lanjutkan Nonton</span>
                <h3 className="text-sm font-semibold text-white">{lastWatched.judulSeri}</h3>
                <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                  <span>Episode {lastWatched.nomorEp || 'Terakhir'}</span>
                  <span>•</span>
                  <span>{formatDuration(lastWatched.progress)} / {formatDuration(lastWatched.duration)}</span>
                </div>
              </div>
            </div>

            <Link
              to={`/player?url=${encodeURIComponent(lastWatched.url)}&seriUrl=${encodeURIComponent(decodedUrl)}&seriJudul=${encodeURIComponent(data.judul_seri)}&judul=${encodeURIComponent(lastWatched.judulSeri)}&gambar=${encodeURIComponent(cover)}`}
              className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-bold shadow-lg shadow-accent/20 transition-all shrink-0"
            >
              Lanjutkan Nonton
            </Link>
          </div>
        )}

        {/* Episode List Section */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Film className="w-5 h-5 text-accent" />
              <h2 className="text-lg font-bold text-white">Daftar Episode ({episodes.length})</h2>
            </div>

            <div className="flex items-center gap-3">
              {/* Search in episodes */}
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari nomor/judul episode..."
                  className="w-48 sm:w-60 pl-8 pr-3 py-1.5 rounded-xl bg-surface border border-white/10 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-accent"
                />
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              </div>

              {/* Sort Toggle */}
              <button
                onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface hover:bg-white/10 border border-white/10 text-xs text-gray-300 hover:text-white transition-colors"
                title="Ubah Urutan"
              >
                <ArrowUpDown className="w-3.5 h-3.5 text-accent" />
                <span>{sortOrder === 'desc' ? 'Terbaru' : 'Terlama'}</span>
              </button>
            </div>
          </div>

          {filteredEpisodes.length === 0 ? (
            <div className="p-8 text-center text-gray-400 bg-surface rounded-2xl border border-white/5">
              <p className="text-sm">Episode tidak ditemukan</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {filteredEpisodes.map((ep, idx) => {
                const epUrl = getPrimaryEpisodeUrl(ep);
                const isWatched = lastWatched && lastWatched.url === epUrl;
                const epTitle = ep.judul || ep.title || `Episode ${idx + 1}`;

                return (
                  <Link
                    key={epUrl || idx}
                    to={`/player?url=${encodeURIComponent(epUrl)}&seriUrl=${encodeURIComponent(decodedUrl)}&seriJudul=${encodeURIComponent(data.judul_seri)}&judul=${encodeURIComponent(epTitle)}&gambar=${encodeURIComponent(cover)}`}
                    className={`group flex items-center justify-between p-3.5 rounded-2xl border transition-all ${
                      isWatched
                        ? 'bg-accent/10 border-accent/40 shadow-sm'
                        : 'bg-card border-white/5 hover:border-accent/40 hover:bg-surface'
                    }`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        isWatched ? 'bg-accent text-white' : 'bg-surface text-gray-400 group-hover:text-accent group-hover:bg-accent/10'
                      }`}>
                        <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                      </div>

                      <div className="overflow-hidden">
                        <h4 className="text-xs font-semibold text-white group-hover:text-accent transition-colors line-clamp-1">
                          {epTitle}
                        </h4>
                        {ep.tanggal && (
                          <span className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
                            <Clock className="w-3 h-3" />
                            {ep.tanggal}
                          </span>
                        )}
                      </div>
                    </div>

                    {isWatched && (
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-accent px-2 py-0.5 rounded-md bg-accent/20">
                        Ditonton
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
