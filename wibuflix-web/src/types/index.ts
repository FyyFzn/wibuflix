export interface AnimeItem {
  judul: string;
  url: string;
  gambar: string;
  gambarScraper?: string;
  tipe: string;
  skor: string;
  status: string;
  id?: string;
  sources?: any;
  sourceUrls?: string[];
}

export interface KatalogResponse {
  status: string;
  data: {
    list: AnimeItem[];
    hasNext: boolean;
  };
}

export interface HotAnimeResponse {
  status: string;
  data: {
    list: AnimeItem[];
  };
}

export interface MalInfo {
  malId: number | null;
  malUrl?: string | null;
  malScore: string | null;
  malRank?: number | null;
  genres: string[];
  synopsis: string | null;
  episodes: number | null;
  status: string;
  studios?: string[];
  year: number | null;
  rating?: string | null;
  cover: string;
  coverWebp?: string | null;
}

export interface EpisodeItem {
  judul: string;
  title?: string;
  num?: number | null;
  id?: string;
  url?: string;
  urls?: string[] | Record<string, string>;
  available_sources?: string[];
  tanggal?: string;
  malJudul?: string;
}

export interface EpisodesResponse {
  status: string;
  data: {
    judul_seri: string;
    cover_scraper: string;
    daftar_episode: EpisodeItem[];
    mal: MalInfo | null;
  };
}

export interface ServerItem {
  nama: string;
  post: string;
  nume: string;
  type: string;
  aktif: boolean;
  iframeUrl?: string;
  namaHost?: string;
  source?: string;
}

export interface ScrapeResponse {
  status: string;
  data: {
    judul: string;
    gambar: string;
    nav_prev: string | null;
    nav_next: string | null;
    servers: ServerItem[];
    iframeAktif: string | null;
  };
}

export interface SmartPlayResponse {
  success: boolean;
  status: 'READY' | 'UPLOADING' | 'FAILED' | 'PENDING';
  url?: string;
  message?: string;
  progress?: number;
  nav_prev?: string | null;
  nav_next?: string | null;
  servers?: ServerItem[];
  judul?: string;
}

export interface QueueItem {
  id: string;
  episodeUrl: string;
  seriesUrl?: string;
  seriesSlug: string;
  seriesTitle: string;
  episodeTitle: string;
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress?: string;
  createdAt: number;
  uniqueId?: string;
  cover?: string;
}

export interface WatchHistoryItem {
  judulSeri: string;
  nomorEp: string;
  url: string;         // episode URL
  seriUrl: string;      // series URL
  gambar: string;
  waktu: number;        // timestamp when watched
  progress: number;     // seconds watched (position)
  duration: number;     // total duration in seconds
  host?: string;        // last active server
  uniqueId?: string;    // MAL ID or series unique ID
}
