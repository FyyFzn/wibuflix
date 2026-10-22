import {
  KatalogResponse,
  HotAnimeResponse,
  EpisodesResponse,
  ScrapeResponse,
  SmartPlayResponse,
  QueueItem
} from '../types';

export const API_BASE = (import.meta as any).env?.VITE_API_BASE || 'https://api.wibuflix.me';

const SYNC_TOKEN_KEY = 'wibuflix_sync_token';

export function getSyncToken(): string {
  try {
    return localStorage.getItem(SYNC_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setSyncToken(token: string): void {
  try {
    if (!token) {
      localStorage.removeItem(SYNC_TOKEN_KEY);
    } else {
      localStorage.setItem(SYNC_TOKEN_KEY, token.trim());
    }
  } catch (e) {
    console.warn('[API] Gagal menyimpan sync token:', e);
  }
}

export function getAuthHeaders(): Record<string, string> {
  const token = getSyncToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['x-sync-token'] = token;
  }
  return headers;
}

// In-memory cache
const memoryCache = new Map<string, { data: any; expiry: number }>();

async function fetchWithCache<T>(
  url: string,
  cacheKey: string,
  ttlMs = 300000,
  signal?: AbortSignal,
  forceRefresh = false
): Promise<T> {
  if (!forceRefresh) {
    const cached = memoryCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.data as T;
    }
  }

  const res = await fetch(url, { headers: getAuthHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  memoryCache.set(cacheKey, { data, expiry: Date.now() + ttlMs });
  return data;
}

export async function fetchKatalog(
  page = 1,
  search = '',
  tab = 'all',
  typeFilter = '',
  genreFilter = '',
  sort = 'az',
  signal?: AbortSignal,
  forceRefresh = false
): Promise<KatalogResponse> {
  let url = `${API_BASE}/api/katalog?page=${page}&tab=${tab}&sort=${sort}`;
  if (search) url += `&s=${encodeURIComponent(search)}`;
  if (typeFilter && typeFilter !== 'Semua') url += `&typeFilter=${encodeURIComponent(typeFilter)}`;
  if (genreFilter && genreFilter !== 'Semua') url += `&genre=${encodeURIComponent(genreFilter)}`;

  const cacheKey = `katalog_${page}_${search}_${tab}_${typeFilter}_${genreFilter}_${sort}`;
  return fetchWithCache<KatalogResponse>(url, cacheKey, 300000, signal, forceRefresh);
}

export async function fetchHotAnime(signal?: AbortSignal): Promise<HotAnimeResponse> {
  const cacheKey = 'hot_anime';
  return fetchWithCache<HotAnimeResponse>(`${API_BASE}/api/hot`, cacheKey, 600000, signal);
}

export async function fetchEpisodes(
  targetUrl: string,
  urls?: any,
  signal?: AbortSignal
): Promise<EpisodesResponse> {
  let url = `${API_BASE}/api/v2/episodes?url=${encodeURIComponent(targetUrl)}`;
  if (urls) {
    url += `&urls=${encodeURIComponent(typeof urls === 'string' ? urls : JSON.stringify(urls))}`;
  }
  const cacheKey = `episodes_${targetUrl}`;
  return fetchWithCache<EpisodesResponse>(url, cacheKey, 300000, signal);
}

export async function scrapeVideo(
  targetUrl: string,
  seriesTitle?: string,
  episodeTitle?: string,
  signal?: AbortSignal,
  urls?: string
): Promise<ScrapeResponse> {
  let url = `${API_BASE}/api/scrape?url=${encodeURIComponent(targetUrl)}`;
  if (urls) url += `&urls=${encodeURIComponent(urls)}`;
  if (seriesTitle) url += `&series=${encodeURIComponent(seriesTitle)}`;
  if (episodeTitle) url += `&episode=${encodeURIComponent(episodeTitle)}`;

  const res = await fetch(url, { headers: getAuthHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSmartPlay(
  episodeUrl: string,
  seriesUrl?: string,
  nextEpisodeUrl?: string,
  signal?: AbortSignal,
  seriesTitle?: string,
  episodeTitle?: string,
  uniqueId?: string,
  urls?: string
): Promise<SmartPlayResponse> {
  let url = `${API_BASE}/api/v2/stream?episodeUrl=${encodeURIComponent(episodeUrl)}`;
  if (seriesUrl) url += `&seriesUrl=${encodeURIComponent(seriesUrl)}`;
  if (nextEpisodeUrl) url += `&nextEpisodeUrl=${encodeURIComponent(nextEpisodeUrl)}`;
  if (seriesTitle) url += `&seriesTitle=${encodeURIComponent(seriesTitle)}`;
  if (episodeTitle) url += `&episodeTitle=${encodeURIComponent(episodeTitle)}`;
  if (uniqueId) url += `&uniqueId=${encodeURIComponent(uniqueId)}`;
  if (urls) url += `&urls=${encodeURIComponent(urls)}`;

  const res = await fetch(url, { headers: getAuthHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.status === 'success' && json.data) {
    return {
      success: true,
      status: json.data.stream_status || 'UPLOADING',
      url: json.data.url,
      message: json.data.message,
      progress: json.data.progress,
      nav_prev: json.data.nav_prev || null,
      nav_next: json.data.nav_next || null,
      servers: json.data.servers || [],
      judul: json.data.judul
    };
  }
  return json;
}

export async function fetchQueueStatus(signal?: AbortSignal): Promise<{ success: boolean; queue: QueueItem[] }> {
  const res = await fetch(`${API_BASE}/api/queue/status`, { headers: getAuthHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function queuePrioritize(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/api/queue/prioritize`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ id })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function queueCancel(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/api/queue/cancel`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ id })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
