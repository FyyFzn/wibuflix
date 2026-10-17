import axios from 'axios';
import * as cheerio from 'cheerio';
import { getCache } from '../../utils/cacheManager.js';
import { formatEpisodeTitle } from '../../utils/stringUtils.js';
import { assertAndRespondContract } from '../../utils/contractValidator.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';

const SCRAPER_BASE = `http://localhost:${process.env.SCRAPER_PORT || 5001}`;
const cache = getCache('episodes_oploverz', 3600);

export const scraperMeta = {
    id: 'oploverz',
    name: 'Oploverz',
    domains: ['oploverz']
};

export const scrapeEpisodes = getOploverzEpisodes;

export async function getOploverzEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `oploverz_eps_${targetUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Oploverz Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/oploverz/series`, { url: targetUrl }, { timeout: 35000 });
    if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
        throw new Error(`Python scraper mengembalikan data kosong untuk ${targetUrl}`);
    }
    cache.set(cacheKey, data);
    return data;
}

export async function getOploverzServers(episodeUrl) {
    if (!episodeUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `oploverz_srv_${episodeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    console.log(`[Oploverz Fast Fetch] Servers: ${episodeUrl}`);
    let slot;
    try {
        const response = await axios.get(episodeUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });
        const html = response.data;
        const $ = cheerio.load(html);

        let judul = $('h1').first().text().trim() || $('title').text().replace(/Oploverz/i, '').replace(/subtitle indonesia/i, '').trim();
        judul = formatEpisodeTitle(judul);

        const servers = [];
        const seenServers = new Set();
        let serverIdCounter = 1;

        // 1. Ekstrak Iframe (Streaming)
        $('iframe').each((_, el) => {
            const src = $(el).attr('src');
            if (src && src.startsWith('http')) {
                // Tentukan provider iframe (Blogger, dll)
                let providerName = 'Server Stream';
                if (src.includes('blogger.com') || src.includes('video.g')) providerName = 'Blogger';
                else if (src.includes('desustream')) providerName = 'Desustream';
                else if (src.includes('youtube')) providerName = 'YouTube';

                const srvKey = `iframe-${src}`;
                if (!seenServers.has(srvKey)) {
                    seenServers.add(srvKey);
                    servers.push({
                        nama: providerName.toUpperCase(),
                        url: src,
                        aktif: servers.length === 0,
                        id: `oploverz-stream-${serverIdCounter++}`,
                        kualitas: 'HD',
                        tipe: 'embed',
                        provider: providerName.toLowerCase()
                    });
                }
            }
        });

        // 2. Ekstrak Link Download Khusus
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            const linkText = $(el).text().trim();
            
            if (href && href.startsWith('http') && !href.includes('oploverz')) {
                if (linkText.length > 2 && linkText.length <= 25 && !linkText.toLowerCase().includes('login') && !linkText.toLowerCase().includes('register')) {

                    const hostLower = linkText.toLowerCase();
                    const isExtractable = hostLower.includes('mega') || hostLower.includes('acefile') || hostLower.includes('filedon') || hostLower.includes('gofile') || hostLower.includes('pdrain') || hostLower.includes('pixeldrain');
                    
                    // Coba tentukan resolusi dari teks sekitarnya
                    let quality = 'HD';
                    const parentText = $(el).parent().text() || '';
                    if (parentText.includes('1080p') || linkText.includes('1080p')) quality = '1080p';
                    else if (parentText.includes('720p') || linkText.includes('720p')) quality = '720p';
                    else if (parentText.includes('480p') || linkText.includes('480p')) quality = '480p';
                    else if (parentText.includes('360p') || linkText.includes('360p')) quality = '360p';

                    const srvKey = `dl-${href}-${quality}`;
                    if (!seenServers.has(srvKey)) {
                        seenServers.add(srvKey);
                        servers.push({
                            nama: `${linkText.toUpperCase()} (MP4 ${quality})`,
                            url: href,
                            aktif: servers.length === 0,
                            id: `oploverz-dl-${serverIdCounter++}`,
                            kualitas: quality,
                            tipe: isExtractable ? 'extractable_download' : 'download',
                            provider: hostLower
                        });
                    }
                }
            }
        });

        // 3. Navigasi Nav Next / Prev
        let nav_prev = null;
        let nav_next = null;
        
        const epNumMatch = episodeUrl.match(/\/episode\/(\d+)/i);
        if (epNumMatch) {
             const currentEp = parseInt(epNumMatch[1], 10);
             if (currentEp > 1) {
                 nav_prev = episodeUrl.replace(/\/episode\/\d+/i, `/episode/${currentEp - 1}`);
             }
             nav_next = episodeUrl.replace(/\/episode\/\d+/i, `/episode/${currentEp + 1}`);
        }

        const result = { judul, servers, nav_prev, nav_next, debug_info: "OK" };
        if (servers.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;
    } catch (err) {
        console.error(`[Oploverz Servers Error] ${episodeUrl}:`, err.message);
        return { judul: "Error", servers: [], nav_prev: null, nav_next: null, debug_info: err.message };
    }
}

export async function handleGetEpisodes(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: 'Parameter url wajib diisi' });
        const data = await getOploverzEpisodes(url);
        if (!assertAndRespondContract(res, data, 'episodes', 'Oploverz')) return;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

export async function handleGetServers(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: 'Parameter url wajib diisi' });
        const data = await getOploverzServers(url);
        if (!assertAndRespondContract(res, data, 'servers', 'Oploverz')) return;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

export async function getOploverzLatestUpdates() {
    const { PROVIDER_URLS } = await import('../../config/providerUrls.js');
    const url = `${PROVIDER_URLS.OPLOVERZ.BASE_URL}/schedule`;
    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/oploverz/latest`, { url }, { timeout: 35000 });
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('[Oploverz] Python latest scraper mengembalikan data kosong');
    }
    return data;
}


// --- DYNAMIC PLUGIN SYSTEM ALIASES ---
export const scrapeServers = getOploverzServers;
export const scrapeLatestUpdates = getOploverzLatestUpdates;
