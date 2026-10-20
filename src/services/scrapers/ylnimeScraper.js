import * as cheerio from 'cheerio';
import axios from 'axios';
import { getCache } from '../../utils/cacheManager.js';
import { cleanSeriesTitle, extractEpNum } from '../../utils/stringUtils.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';

const cache = getCache('episodes', 3600);

export const scraperMeta = {
    id: 'ylnime',
    name: 'YLnime',
    domains: ['ylnime.com', 'ylnime']
};

export const scrapeEpisodes = getYlnimeEpisodes;
export const scrapeServers = getYlnimeServers;
export const scrapeLatestUpdates = getYlnimeLatestUpdates;

const BASE_URL = PROVIDER_URLS.YLNIME.BASE_URL;
const SCRAPER_BASE = `http://localhost:${process.env.SCRAPER_PORT || 5001}`;

const AX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
    'Referer': BASE_URL + '/'
};

/**
 * Mengambil daftar episode dari halaman seri YLnime.
 * URL format: https://ylnime.com/index.php?series={slug}
 *             atau https://ylnime.com/?series={slug}
 */
export async function getYlnimeEpisodes(animeUrl) {
    const cacheKey = `ylnime_eps_${animeUrl}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/ylnime/series`, { url: animeUrl }, { timeout: 35000 });
    if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
        throw new Error(`Python scraper mengembalikan data kosong untuk ${animeUrl}`);
    }
    cache.set(cacheKey, data);
    return data;
}

/**
 * Mengambil server video dari halaman episode YLnime.
 * URL format: https://ylnime.com/index.php?series={slug}&ep={num}
 */
export async function getYlnimeServers(episodeUrl) {
    const cacheKey = `ylnime_srv_${episodeUrl}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const { data } = await axios.post(
            `${SCRAPER_BASE}/scrape/ylnime/episode`,
            { url: episodeUrl },
            { timeout: 35000 }
        );
        
        if (!data || !data.servers || data.servers.length === 0) {
            console.warn(`[YLnime] Tidak ada server ditemukan untuk ${episodeUrl}`);
            return { judul: data?.judul || 'Episode', servers: [], nav_prev: null, nav_next: null };
        }

        // Normalize server structure to match expected format
        const servers = data.servers.map((s, idx) => ({
            ...s,
            nume: s.nume || `${idx + 1}`,
            id: s.id || `${idx + 1}`,
            post: s.post || '',
            tipe: s.type,
            aktif: true,
            iframeUrl: s.url,
            source: 'ylnime',
            provider: 'ylnime'
        }));

        const result = {
            judul: data.judul || 'Episode',
            servers,
            nav_prev: null,
            nav_next: null
        };

        cache.set(cacheKey, result);
        return result;
    } catch (err) {
        console.error(`[YLnime] Error fetching servers for ${episodeUrl}:`, err.message);
        return { judul: 'Episode', servers: [], nav_prev: null, nav_next: null };
    }
}


/**
 * Mengambil daftar anime terbaru dari halaman beranda YLnime.
 */
export async function getYlnimeLatestUpdates() {
    const cacheKey = `ylnime_latest`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/ylnime/latest`, { url: `${BASE_URL}/index.php?terbaru=1` }, { timeout: 35000 });
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('[YLnime] Python latest scraper mengembalikan data kosong');
    }
    return data;
}

function extractHostname(url) {
    try {
        return new URL(url.startsWith('//') ? `https:${url}` : url).hostname.replace('www.', '');
    } catch {
        return 'Unknown';
    }
}
