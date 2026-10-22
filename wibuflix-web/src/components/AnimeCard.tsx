import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Play } from 'lucide-react';
import { AnimeItem } from '../types';

interface AnimeCardProps {
  anime: AnimeItem;
  lastEpisode?: string;
  progress?: number;
  duration?: number;
}

export default function AnimeCard({ anime, lastEpisode, progress, duration }: AnimeCardProps) {
  const [imgError, setImgError] = useState(false);

  const displayImage = imgError
    ? 'https://via.placeholder.com/300x450/181926/888888?text=Wibuflix'
    : (anime.gambar || anime.gambarScraper || 'https://via.placeholder.com/300x450/181926/888888?text=Wibuflix');

  const detailUrl = `/detail/${encodeURIComponent(anime.url)}`;

  const percent = progress && duration && duration > 0
    ? Math.min(100, Math.round((progress / duration) * 100))
    : 0;

  return (
    <Link
      to={detailUrl}
      className="group relative flex flex-col rounded-2xl bg-card border border-white/5 overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:border-accent/40 hover:shadow-xl hover:shadow-accent/10"
    >
      {/* Poster Image Container */}
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-surface">
        <img
          src={displayImage}
          alt={anime.judul}
          loading="lazy"
          onError={() => setImgError(true)}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />

        {/* Dark Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-card via-transparent to-black/40 opacity-80 group-hover:opacity-60 transition-opacity" />

        {/* Top Badges */}
        <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-1 pointer-events-none">
          {anime.skor && anime.skor !== '-' && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-black/60 backdrop-blur-md text-amber-400 text-xs font-bold shadow">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              <span>{anime.skor}</span>
            </span>
          )}

          {anime.tipe && (
            <span className="ml-auto px-2 py-0.5 rounded-lg bg-accent/80 backdrop-blur-md text-white text-[11px] font-semibold uppercase tracking-wider shadow">
              {anime.tipe}
            </span>
          )}
        </div>

        {/* Play Icon on Hover */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-accent/90 text-white flex items-center justify-center shadow-lg shadow-accent/40 transform scale-90 group-hover:scale-100 transition-transform">
            <Play className="w-6 h-6 fill-white ml-0.5" />
          </div>
        </div>

        {/* Progress Bar (if watched) */}
        {percent > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/50">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </div>

      {/* Info Content */}
      <div className="flex flex-col flex-1 p-3.5">
        <h3
          className="text-sm font-semibold text-white group-hover:text-accent transition-colors line-clamp-2 leading-snug"
          title={anime.judul}
        >
          {anime.judul}
        </h3>

        <div className="mt-auto pt-2 flex items-center justify-between text-[11px] text-gray-400">
          <span>{anime.status || 'Tersedia'}</span>
          {lastEpisode && (
            <span className="text-accent font-medium">{lastEpisode}</span>
          )}
        </div>
      </div>
    </Link>
  );
}
