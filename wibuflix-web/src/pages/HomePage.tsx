import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Play, Star, Flame, Sparkles, RefreshCw } from 'lucide-react';
import { fetchHotAnime, fetchKatalog } from '../services/api';
import { AnimeItem } from '../types';
import AnimeCard from '../components/AnimeCard';

export default function HomePage() {
  const [featured, setFeatured] = useState<AnimeItem | null>(null);
  const [hotList, setHotList] = useState<AnimeItem[]>([]);
  const [latestAnime, setLatestAnime] = useState<AnimeItem[]>([]);
  const [latestToku, setLatestToku] = useState<AnimeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [hotRes, latestAnimeRes, latestTokuRes] = await Promise.allSettled([
        fetchHotAnime(),
        fetchKatalog(1, '', 'anime', '', '', 'latest'),
        fetchKatalog(1, '', 'toku', '', '', 'latest')
      ]);

      if (hotRes.status === 'fulfilled' && hotRes.value.data?.list?.length) {
        const list = hotRes.value.data.list;
        setHotList(list);
        setFeatured(list[0]);
      }

      if (latestAnimeRes.status === 'fulfilled') {
        const list = latestAnimeRes.value.data?.list || [];
        setLatestAnime(list.slice(0, 12));
        if (!featured && list.length > 0) {
          setFeatured(list[0]);
        }
      }

      if (latestTokuRes.status === 'fulfilled') {
        setLatestToku(latestTokuRes.value.data?.list || []);
      }
    } catch (err: any) {
      setError(err?.message || 'Gagal memuat beranda');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center gap-3">
        <RefreshCw className="w-8 h-8 text-accent animate-spin" />
        <p className="text-sm text-gray-400">Memuat beranda Wibuflix...</p>
      </div>
    );
  }

  if (error && !featured && hotList.length === 0) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 text-center px-4">
        <p className="text-red-400 text-sm font-medium">{error}</p>
        <button
          onClick={loadData}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-semibold rounded-xl transition-colors"
        >
          Coba Lagi
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-12 pb-16">
      {/* Featured Hero Banner */}
      {featured && (
        <section className="relative w-full h-[460px] md:h-[540px] overflow-hidden bg-surface">
          {/* Background Poster Blur */}
          <div className="absolute inset-0">
            <img
              src={featured.gambar || featured.gambarScraper}
              alt={featured.judul}
              className="w-full h-full object-cover object-center filter blur-md scale-110 opacity-30"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-transparent" />
          </div>

          <div className="relative max-w-7xl mx-auto h-full px-4 sm:px-6 lg:px-8 flex flex-col justify-end pb-12 md:pb-16">
            <div className="max-w-2xl space-y-4">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/20 border border-accent/40 text-accent text-xs font-bold uppercase tracking-wider">
                  <Sparkles className="w-3.5 h-3.5" />
                  Featured
                </span>
                {featured.skor && featured.skor !== '-' && (
                  <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-amber-400 text-xs font-semibold">
                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                    <span>{featured.skor}</span>
                  </span>
                )}
                {featured.tipe && (
                  <span className="px-2.5 py-1 rounded-full bg-surface text-gray-300 text-xs font-medium">
                    {featured.tipe}
                  </span>
                )}
              </div>

              <h1 className="text-3xl md:text-5xl font-black text-white tracking-tight leading-tight line-clamp-2">
                {featured.judul}
              </h1>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Link
                  to={`/detail/${encodeURIComponent(featured.url)}`}
                  className="flex items-center gap-2.5 px-6 py-3 rounded-xl bg-accent hover:bg-accent-hover text-white font-bold text-sm shadow-xl shadow-accent/30 hover:scale-105 active:scale-95 transition-all"
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>Nonton Sekarang</span>
                </Link>

                <Link
                  to="/katalog"
                  className="px-5 py-3 rounded-xl bg-surface/80 hover:bg-surface text-gray-200 hover:text-white font-semibold text-sm border border-white/10 transition-colors"
                >
                  Jelajah Katalog
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        {/* Hot / Trending Section */}
        {hotList.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Flame className="w-5 h-5 text-accent" />
                <h2 className="text-xl font-bold text-white tracking-tight">Sedang Hangat (Trending)</h2>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {hotList.slice(0, 6).map((anime, idx) => (
                <AnimeCard key={anime.url || idx} anime={anime} />
              ))}
            </div>
          </section>
        )}

        {/* Latest Anime Section */}
        {latestAnime.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-accent" />
                <h2 className="text-xl font-bold text-white tracking-tight">Episode Anime Terbaru</h2>
              </div>
              <Link
                to="/katalog?tab=anime&sort=latest"
                className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors"
              >
                Lihat Semua &rarr;
              </Link>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {latestAnime.map((anime, idx) => (
                <AnimeCard key={anime.url || idx} anime={anime} />
              ))}
            </div>
          </section>
        )}

        {/* Latest Tokusatsu Section */}
        {latestToku.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Flame className="w-5 h-5 text-orange-400" />
                <h2 className="text-xl font-bold text-white tracking-tight">Tokusatsu Terbaru</h2>
              </div>
              <Link
                to="/katalog?tab=toku&sort=latest"
                className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors"
              >
                Lihat Semua &rarr;
              </Link>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {latestToku.slice(0, 6).map((anime, idx) => (
                <AnimeCard key={anime.url || idx} anime={anime} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
