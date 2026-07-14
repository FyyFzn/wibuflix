import { cache } from './neosatsu/neosatsuShared.js';
import { getNeosatsuCatalog } from './neosatsu/neosatsuCatalogScraper.js';
import { getNeosatsuEpisodes } from './neosatsu/neosatsuEpisodeScraper.js';

export { cache, getNeosatsuCatalog, getNeosatsuEpisodes };

/**
 * [TAHAP 3] Mengambil server dari cache yang sudah di-scrape di Tahap 2
 */
export async function getNeosatsuServers(fakeUrl) {
    const [targetUrl, epId] = fakeUrl.split('___neosatsu_ep___');
    if (!targetUrl || !epId) return { judul: '', servers: [], nav_prev: null, nav_next: null };

    const titleTarget = epId.replace(/_/g, ' ');

    const cacheData = cache.get(targetUrl);
    if (cacheData) {
        const episodeList = cacheData.daftar_episode;
        const idx = episodeList.findIndex(e => e.judul === titleTarget);
        if (idx !== -1) {
            const episode = episodeList[idx];
            return {
                judul: episode.judul,
                judul_seri: cacheData.judul_seri,
                cover_scraper: cacheData.cover_scraper,
                servers: episode._servers || [],
                nav_prev: idx > 0 ? episodeList[idx - 1].url : null,
                nav_next: idx < episodeList.length - 1 ? episodeList[idx + 1].url : null
            };
        }
    }

    console.info("[Neosatsu Servers] Cache tidak ditemukan, mengambil ulang post...");
    const data = await getNeosatsuEpisodes(targetUrl);
    const episodeList = data.daftar_episode;
    const idx = episodeList.findIndex(e => e.judul === titleTarget);
    if (idx !== -1) {
        const episode = episodeList[idx];
        return {
            judul: episode.judul,
            judul_seri: data.judul_seri,
            cover_scraper: data.cover_scraper,
            servers: episode._servers || [],
            nav_prev: idx > 0 ? episodeList[idx - 1].url : null,
            nav_next: idx < episodeList.length - 1 ? episodeList[idx + 1].url : null
        };
    }

    return { judul: titleTarget, servers: [], nav_prev: null, nav_next: null };
}

export async function getNeosatsuLatestUpdates() {
    try {
        const catalog = await getNeosatsuCatalog(1);
        const updates = [];
        for (const item of catalog) {
            if (item.judul && item.url) {
                updates.push({ title: item.judul, status: item.episode_terbaru || 'Completed', url: item.url });
            }
        }
        return updates;
    } catch (e) {
        console.error(`[Neosatsu Scraper] Gagal memuat updates:`, e.message);
        return [];
    }
}
