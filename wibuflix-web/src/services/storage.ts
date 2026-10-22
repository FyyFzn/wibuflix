import { WatchHistoryItem } from '../types';
import { API_BASE, getAuthHeaders } from './api';

const HISTORY_KEY = 'wibuflix_riwayat';
const PROGRESS_KEY = 'wibuflix_progress';
const MAX_HISTORY_ITEMS = 150;

export interface EpisodeProgress {
  progress: number;
  duration: number;
  waktu: number;
}

export function cleanSeriesTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  let jt = rawTitle.trim();
  jt = jt.replace(/[-–|]\s*[a-zA-Z0-9\s]+$/i, '');
  jt = jt.replace(/\s*(?:\(?Sub(?:title)?\s*Indo(?:nesia)?\)?)\s*/gi, '');
  jt = jt.replace(/(?:Episode|Eps)\s*\d+\s*-\s*\d+.*$/i, '');
  jt = jt.replace(/\s*\d+\s*-\s*\d+\s*(?:Tamat|End)?.*$/i, '');
  jt = jt.replace(/(?:Episode|Eps)\s*\d+.*$/i, '');
  jt = jt.replace(/\s*OVA\s*\d*.*$/i, '');
  jt = jt.replace(/(?:\s*[\(\[]?BD[\)\]]?\s*)?(?:\s*[\(\[]?Batch[\)\]]?\s*)/gi, '');
  jt = jt.replace(/\s*[\(\[]?(?:End|Tamat)[\)\]]?\s*/gi, '');
  jt = jt.replace(/\s*[-–|]\s*$/i, '');
  return jt.replace(/[-\s]+$/, '').replace(/\s+/g, ' ').trim();
}

export function formatWaktuYangLalu(timestamp: number): string {
  const detik = Math.floor((Date.now() - timestamp) / 1000);
  if (detik < 60) return 'Baru saja';
  const menit = Math.floor(detik / 60);
  if (menit < 60) return `${menit} mnt yang lalu`;
  const jam = Math.floor(menit / 60);
  if (jam < 24) return `${jam} jam yang lalu`;
  const hari = Math.floor(jam / 24);
  if (hari < 7) return `${hari} hari yang lalu`;
  return new Date(timestamp).toLocaleDateString('id-ID');
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function pushHistoryToCloud(item: WatchHistoryItem): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/history`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(item)
    });
  } catch {
    // Non-blocking fire-and-forget sync
  }
}

async function pushProgressToCloud(
  url: string,
  progress: number,
  duration: number,
  host?: string
): Promise<void> {
  try {
    const riwayat = getRawRiwayat();
    const existing = riwayat.find(r => r.url === url);
    const validDuration = duration > 0 ? duration : (existing?.duration || 1);

    const payload: Partial<WatchHistoryItem> & { url: string; progress: number; duration: number } = existing ? {
      ...existing,
      progress: Math.min(progress, validDuration),
      duration: validDuration,
      waktu: Date.now(),
      ...(host ? { host } : {})
    } : {
      judulSeri: url,
      nomorEp: '',
      url,
      seriUrl: '',
      gambar: '',
      progress: Math.min(progress, validDuration),
      duration: validDuration,
      waktu: Date.now(),
      ...(host ? { host } : {})
    };

    await fetch(`${API_BASE}/api/history`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
  } catch {
    // Non-blocking fire-and-forget sync
  }
}

export function getRawRiwayat(): WatchHistoryItem[] {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    if (!data) return [];
    return JSON.parse(data) as WatchHistoryItem[];
  } catch {
    return [];
  }
}

export function getRiwayat(): WatchHistoryItem[] {
  try {
    const parsed = getRawRiwayat();
    const cleanedMap = new Map<string, WatchHistoryItem>();

    parsed.forEach(item => {
      let jt = cleanSeriesTitle(item.judulSeri || '');
      if (!jt) jt = item.judulSeri;
      const key = item.seriUrl || jt;
      const existing = cleanedMap.get(key);
      if (!existing) {
        cleanedMap.set(key, { ...item, judulSeri: jt });
      }
    });

    return Array.from(cleanedMap.values());
  } catch {
    return [];
  }
}

export async function simpanKeRiwayat(
  judul: string,
  url: string,
  seriUrl: string,
  gambar: string,
  progress: number = 0,
  duration: number = 0,
  host?: string,
  seriJudul?: string,
  uniqueId?: string
): Promise<void> {
  try {
    let baseJudul = cleanSeriesTitle(judul);
    if (!baseJudul) baseJudul = judul;
    let finalJudulSeri = cleanSeriesTitle(seriJudul || baseJudul);
    if (!finalJudulSeri) finalJudulSeri = seriJudul || baseJudul;

    const judulSeri = finalJudulSeri;
    const epMatch = judul.match(/(?:Episode|Eps|OVA)\s+(\d+(?:\.\d+)?)/i) || judul.match(/\s+(\d+)\s+Sub/i) || judul.match(/\s+(\d+)$/i);
    const nomorEp = epMatch ? epMatch[1] : '';

    let riwayat = getRawRiwayat();
    riwayat = riwayat.filter(r => r.url !== url && (seriUrl ? r.seriUrl !== seriUrl : r.judulSeri !== judulSeri));

    const newItem: WatchHistoryItem = {
      judulSeri,
      nomorEp,
      url,
      seriUrl,
      gambar,
      waktu: Date.now(),
      progress,
      duration,
      host,
      uniqueId
    };

    riwayat.unshift(newItem);
    if (riwayat.length > MAX_HISTORY_ITEMS) {
      riwayat = riwayat.slice(0, MAX_HISTORY_ITEMS);
    }

    localStorage.setItem(HISTORY_KEY, JSON.stringify(riwayat));
    pushHistoryToCloud(newItem);
  } catch (e) {
    console.warn('[Storage] Gagal menyimpan ke riwayat:', e);
  }
}

export async function updateProgress(
  url: string,
  progress: number,
  duration: number,
  host?: string
): Promise<void> {
  if (!url || progress < 0 || duration <= 0) return;

  try {
    const riwayat = getRawRiwayat();
    const itemIndex = riwayat.findIndex(r => r.url === url);
    if (itemIndex !== -1) {
      const validDuration = duration > 0 ? duration : (riwayat[itemIndex].duration || 1);
      riwayat[itemIndex].progress = Math.min(progress, validDuration);
      riwayat[itemIndex].duration = validDuration;
      riwayat[itemIndex].waktu = Date.now();
      if (host) riwayat[itemIndex].host = host;
      localStorage.setItem(HISTORY_KEY, JSON.stringify(riwayat));
    }

    const data = localStorage.getItem(PROGRESS_KEY);
    let allProgress: Record<string, EpisodeProgress> = {};
    if (data) {
      try {
        allProgress = JSON.parse(data) || {};
      } catch {
        allProgress = {};
      }
    }

    allProgress[url] = {
      progress: Math.min(progress, duration),
      duration,
      waktu: Date.now()
    };

    localStorage.setItem(PROGRESS_KEY, JSON.stringify(allProgress));
    pushProgressToCloud(url, progress, duration, host);
  } catch (e) {
    console.warn('[Storage] Gagal update progress:', e);
  }
}

export function getProgress(url: string): { progress: number; duration: number; host?: string } | null {
  try {
    const data = localStorage.getItem(PROGRESS_KEY);
    if (data) {
      const allProgress: Record<string, EpisodeProgress> = JSON.parse(data);
      if (allProgress[url] && allProgress[url].progress > 0) {
        return { progress: allProgress[url].progress, duration: allProgress[url].duration };
      }
    }
  } catch {}

  const riwayat = getRawRiwayat();
  const item = riwayat.find(r => r.url === url);
  if (item && item.progress > 0) {
    return { progress: item.progress, duration: item.duration, host: item.host };
  }
  return null;
}

export async function hapusRiwayat(identifier: string): Promise<void> {
  let riwayat = getRawRiwayat();
  riwayat = riwayat.filter(r => r.seriUrl !== identifier && r.judulSeri !== identifier && r.url !== identifier);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(riwayat));

  try {
    await fetch(`${API_BASE}/api/history/${encodeURIComponent(identifier)}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
  } catch {}
}

export async function clearAllHistory(): Promise<void> {
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(PROGRESS_KEY);

  try {
    await fetch(`${API_BASE}/api/history`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
  } catch {}
}

export async function syncHistoryWithCloud(): Promise<WatchHistoryItem[]> {
  try {
    const res = await fetch(`${API_BASE}/api/history`, { headers: getAuthHeaders() });
    if (!res.ok) {
      return getRiwayat();
    }
    const json = await res.json();
    const remoteList: WatchHistoryItem[] = (json && Array.isArray(json.data))
      ? json.data
      : (Array.isArray(json) ? json : []);

    const localList = getRawRiwayat();
    const mergedMap = new Map<string, WatchHistoryItem>();

    const getItemKey = (item: WatchHistoryItem) => {
      let jt = cleanSeriesTitle(item.judulSeri || '');
      if (!jt) jt = item.judulSeri;
      return item.seriUrl || jt || item.url;
    };

    const allItems = [...localList, ...remoteList];
    for (const item of allItems) {
      if (!item || (!item.url && !item.seriUrl && !item.judulSeri)) continue;
      const key = getItemKey(item);
      const existing = mergedMap.get(key);
      if (!existing || (item.waktu || 0) > (existing.waktu || 0)) {
        mergedMap.set(key, item);
      }
    }

    const mergedList = Array.from(mergedMap.values())
      .sort((a, b) => (b.waktu || 0) - (a.waktu || 0))
      .slice(0, MAX_HISTORY_ITEMS);

    localStorage.setItem(HISTORY_KEY, JSON.stringify(mergedList));
    return getRiwayat();
  } catch (err) {
    console.warn('[Storage] syncHistoryWithCloud failed:', err);
    return getRiwayat();
  }
}
