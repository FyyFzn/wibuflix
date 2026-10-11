import axios from 'axios';
import { getCache } from '../../utils/cacheManager.js';
import Anime from '../../models/Anime.js';
import { cleanSeriesTitle } from '../../utils/stringUtils.js';

const SCRAPER_BASE = `http://localhost:${process.env.SCRAPER_PORT || 5001}`;

const cache = getCache('episodes', 3600);

export const scraperMeta = {
    id: 'samehadaku',
    name: 'Samehadaku',
    domains: ['samehadaku', 'v2.samehadaku.how']
};

export const scrapeEpisodes = getSamehadakuEpisodes;

export async function getSamehadakuEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `eps_${targetUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Episodes Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`\n[Episodes Fast Fetch via Python] ${targetUrl}`);

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/samehadaku/series`, { url: targetUrl }, { timeout: 35000 });

    if (!data || !data.daftar_episode) {
        throw new Error('Python scraper mengembalikan respons tidak valid');
    }

    // Jangan cache jika episode kosong — bisa jadi CF masih memblokir
    if (data.daftar_episode.length > 0) {
        cache.set(cacheKey, data);
    }

    return data;
}

export async function getSamehadakuLatestUpdates() {
    const { PROVIDER_URLS } = await import('../../config/providerUrls.js');
    const url = `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`;
    try {
        const { data } = await axios.post(`${SCRAPER_BASE}/scrape/samehadaku/latest`, { url }, { timeout: 35000 });
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error(`[Samehadaku Scraper] Gagal memuat updates:`, e.message);
        return [];
    }
}

export { cache };


// --- DYNAMIC PLUGIN SYSTEM ALIASES ---
import { scrapeVideoServers } from "../extractors/videoExtractor.js";
export const scrapeServers = scrapeVideoServers;
export const scrapeLatestUpdates = getSamehadakuLatestUpdates;
