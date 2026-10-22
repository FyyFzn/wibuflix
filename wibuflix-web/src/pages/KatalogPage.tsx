import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X, ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { fetchKatalog } from '../services/api';
import { AnimeItem } from '../types';
import AnimeCard from '../components/AnimeCard';

const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mecha',
  'Mystery', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Isekai'
];

export default function KatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState(searchParams.get('s') || '');
  const [tab, setTab] = useState<'all' | 'anime' | 'toku'>(
    (searchParams.get('tab') as any) || 'all'
  );
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') || 'Semua');
  const [genre, setGenre] = useState(searchParams.get('genre') || 'Semua');
  const [sort, setSort] = useState<'az' | 'latest'>((searchParams.get('sort') as any) || 'az');
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1);

  const [list, setList] = useState<AnimeItem[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getSubclassOptions = () => {
    if (tab === 'toku') return ['Semua', 'Kamen Rider', 'Super Sentai', 'Power Rangers', 'Ultraman'];
    if (tab === 'anime') return ['Semua', 'TV', 'Movie', 'OVA', 'ONA', 'Special'];
    return ['Semua', 'TV', 'Movie', 'OVA', 'Kamen Rider', 'Super Sentai'];
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchKatalog(page, search, tab, typeFilter, genre, sort);
      setList(res.data?.list || []);
      setHasNext(Boolean(res.data?.hasNext));
    } catch (err: any) {
      setError(err?.message || 'Gagal memuat katalog');
    } finally {
      setLoading(false);
    }
  }, [page, search, tab, typeFilter, genre, sort]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Sync state to URL params
  const updateUrl = (newParams: Record<string, string | number>) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(newParams).forEach(([key, val]) => {
      if (!val || val === 'Semua' || val === 'all' || (key === 'page' && val === 1)) {
        params.delete(key);
      } else {
        params.set(key, String(val));
      }
    });
    setSearchParams(params);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    updateUrl({ s: search, page: 1 });
  };

  const handleTabChange = (newTab: 'all' | 'anime' | 'toku') => {
    setTab(newTab);
    setTypeFilter('Semua');
    setPage(1);
    updateUrl({ tab: newTab, type: 'Semua', page: 1 });
  };

  const handleTypeChange = (newType: string) => {
    setTypeFilter(newType);
    setPage(1);
    updateUrl({ type: newType, page: 1 });
  };

  const handleGenreChange = (newGenre: string) => {
    setGenre(newGenre);
    setPage(1);
    updateUrl({ genre: newGenre, page: 1 });
  };

  const handleSortChange = (newSort: 'az' | 'latest') => {
    setSort(newSort);
    setPage(1);
    updateUrl({ sort: newSort, page: 1 });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Search and Main Filters */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search Input Form */}
          <form onSubmit={handleSearchSubmit} className="relative flex-1">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari judul anime, toku, atau keyword..."
              className="w-full pl-11 pr-10 py-3 rounded-2xl bg-surface border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-accent transition-colors"
            />
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setPage(1);
                  updateUrl({ s: '', page: 1 });
                }}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </form>

          {/* Sort Selector */}
          <div className="flex items-center gap-2">
            <div className="flex bg-surface p-1 rounded-2xl border border-white/10">
              <button
                onClick={() => handleSortChange('az')}
                className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                  sort === 'az' ? 'bg-accent text-white shadow' : 'text-gray-400 hover:text-white'
                }`}
              >
                A - Z
              </button>
              <button
                onClick={() => handleSortChange('latest')}
                className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                  sort === 'latest' ? 'bg-accent text-white shadow' : 'text-gray-400 hover:text-white'
                }`}
              >
                Terbaru
              </button>
            </div>
          </div>
        </div>

        {/* Tab switcher: Semua, Anime, Tokusatsu */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 pb-3">
          {(['all', 'anime', 'toku'] as const).map((t) => (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                tab === t
                  ? 'bg-white text-black'
                  : 'bg-surface hover:bg-white/10 text-gray-400 hover:text-white border border-white/5'
              }`}
            >
              {t === 'all' ? 'Semua Kategori' : t === 'anime' ? 'Anime Saja' : 'Tokusatsu Saja'}
            </button>
          ))}
        </div>

        {/* Subclass Filters */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          <span className="text-xs text-gray-500 flex items-center gap-1 shrink-0">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Tipe:
          </span>
          {getSubclassOptions().map((opt) => (
            <button
              key={opt}
              onClick={() => handleTypeChange(opt)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 transition-colors ${
                typeFilter === opt
                  ? 'bg-accent/20 text-accent border border-accent/40 font-semibold'
                  : 'bg-surface text-gray-400 hover:text-white border border-white/5'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        {/* Genre Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          <span className="text-xs text-gray-500 shrink-0">Genre:</span>
          {['Semua', ...GENRES].map((g) => (
            <button
              key={g}
              onClick={() => handleGenreChange(g)}
              className={`px-3 py-1 rounded-full text-xs font-medium shrink-0 transition-colors ${
                genre === g
                  ? 'bg-accent text-white font-semibold shadow-sm'
                  : 'bg-surface/80 text-gray-400 hover:text-white border border-white/5'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* Anime Grid */}
      {loading ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3">
          <RefreshCw className="w-7 h-7 text-accent animate-spin" />
          <p className="text-xs text-gray-400">Memuat katalog anime...</p>
        </div>
      ) : error ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-semibold rounded-xl"
          >
            Coba Lagi
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center gap-2 text-center text-gray-400">
          <p className="text-base font-semibold text-white">Tidak ada anime ditemukan</p>
          <p className="text-xs">Coba ubah kata kunci pencarian atau sesuaikan filter genre/tipe.</p>
        </div>
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {list.map((anime, idx) => (
              <AnimeCard key={anime.url || idx} anime={anime} />
            ))}
          </div>

          {/* Pagination Controls */}
          <div className="flex items-center justify-center gap-4 pt-6 border-t border-white/5">
            <button
              disabled={page <= 1}
              onClick={() => {
                const prev = Math.max(1, page - 1);
                setPage(prev);
                updateUrl({ page: prev });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface border border-white/10 text-xs font-semibold text-gray-300 hover:text-white disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Sebelumnya</span>
            </button>

            <span className="text-xs font-medium text-gray-400">
              Halaman <span className="text-accent font-bold">{page}</span>
            </span>

            <button
              disabled={!hasNext}
              onClick={() => {
                const next = page + 1;
                setPage(next);
                updateUrl({ page: next });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-surface border border-white/10 text-xs font-semibold text-gray-300 hover:text-white disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              <span>Selanjutnya</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
