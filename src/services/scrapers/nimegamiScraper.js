import axios from 'axios';
import { releaseToPool } from '../../puppeteer/pool.js';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
import * as cheerio from 'cheerio';
import { getCache } from '../../utils/cacheManager.js';
import Anime from '../../models/Anime.js';
import { cleanSeriesTitle } from '../../utils/stringUtils.js';
import { assertAndRespondContract } from '../../utils/contractValidator.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';

const SCRAPER_BASE = `http://localhost:${process.env.SCRAPER_PORT || 5001}`;
const cache = getCache('nimegami', 3600);

/**
 * Decode atribut `data` base64 JSON dari li.select-eps Nimegami.
 * Format: [{format: "360p", url: ["https://..."]}, ...]
 */
function decodeEpisodeData(base64Str) {
    if (!base64Str) return null;
    try {
        const decoded = Buffer.from(base64Str, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * Mengikis daftar episode dari halaman anime Nimegami.
 *
 * Struktur HTML yang benar:
 *   div.streaming_eps_box > div.list_eps_stream > li.select-eps[id="play_eps_N"][data="BASE64_JSON"]
 *
 * Catatan: Setiap <li> berisi teks "Episode N" dan atribut `data` berisi JSON
 * yang di-encode base64 dengan format [{format, url: [...]}, ...].
 */
export async function getNimegamiEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    // Normalisasi URL: hilangkan ?ep parameter jika ada
    let cleanUrl = targetUrl;
    try {
        const u = new URL(targetUrl);
        u.searchParams.delete('ep');
        cleanUrl = u.toString();
    } catch {
        cleanUrl = targetUrl.split('?')[0];
    }

    const cacheKey = `nimegami_eps_v2_${cleanUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Nimegami Episodes Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/nimegami/series`, { url: cleanUrl }, { timeout: 35000 });
    if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
        throw new Error(`Python scraper mengembalikan data kosong untuk ${cleanUrl}`);
    }
    cache.set(cacheKey, data);
    return data;
}

/**
 * Mengambil server streaming untuk episode tertentu berdasarkan Virtual URL (?ep=N).
 *
 * Data stream diambil dari:
 *   1. Cache per-episode yang di-populate oleh getNimegamiEpisodes (paling cepat)
 *   2. Fetch ulang halaman jika cache kosong, cari li[id="play_eps_N"] dan decode data attribute
 */
export async function getNimegamiServers(episodeUrl) {
    if (!episodeUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `nimegami_srv_v2_${episodeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    const urlObj = new URL(episodeUrl);
    const targetEpNum = urlObj.searchParams.get('ep');
    urlObj.searchParams.delete('ep');
    const baseUrl = urlObj.toString().replace(/\/$/, '');

    console.log(`[Nimegami] Fetching servers Ep ${targetEpNum} dari: ${baseUrl}`);

    // 1. Coba ambil dari cache per-episode
    let streamData = null;
    const cacheKeysToTry = [
        `nimegami_ep_data_${baseUrl}_ep${targetEpNum}`,
        `nimegami_ep_data_${baseUrl.replace(/\/$/, '')}_ep${targetEpNum}`,
        `nimegami_ep_data_${baseUrl}//_ep${targetEpNum}`
    ];
    for (const k of cacheKeysToTry) {
        streamData = cache.get(k);
        if (streamData) break;
    }

    // 2. Jika tidak ada di cache, fetch ulang halaman
    if (!streamData) {
        let slot;
        try {
            const fetchRes = await fetchWithCF(baseUrl, { fetchTimeout: 10000 });
            slot = fetchRes.slot;
            const $ = fetchRes.$;

            if (targetEpNum) {
                // Cari li dengan id yang tepat
                const $li = $(`li.select-eps[id="play_eps_${targetEpNum}"]`);
                if ($li.length > 0) {
                    streamData = decodeEpisodeData($li.attr('data') || '');
                }

                // Fallback: iterasi semua li dan cocokkan nomor
                if (!streamData) {
                    $('div.list_eps_stream li.select-eps, .streaming_eps_box li.select-eps').each((_, el) => {
                        const $el = $(el);
                        const idAttr = $el.attr('id') || '';
                        const idMatch = idAttr.match(/play_eps_(\d+)/i);
                        if (idMatch && parseInt(idMatch[1], 10) === parseInt(targetEpNum, 10)) {
                            streamData = decodeEpisodeData($el.attr('data') || '');
                            return false; // break each
                        }
                    });
                }
            } else {
                // Tanpa nomor episode, ambil episode pertama
                const $first = $('div.list_eps_stream li.select-eps').first();
                if ($first.length > 0) {
                    streamData = decodeEpisodeData($first.attr('data') || '');
                }
            }
        } catch (err) {
            throw err;
        } finally {
            if (slot) releaseToPool(slot);
        }
    }

    if (!streamData || !Array.isArray(streamData) || streamData.length === 0) {
        console.warn(`[Nimegami] Tidak ada data stream untuk Ep ${targetEpNum} di ${baseUrl}`);
        return { judul: `Episode ${targetEpNum || '?'}`, servers: [], nav_prev: null, nav_next: null };
    }

    // Transformasi stream data ke format servers standar
    const servers = [];
    const seenKeys = new Set();

    for (const item of streamData) {
        const format = item.format || 'MP4';
        const urls = Array.isArray(item.url) ? item.url : (item.url ? [item.url] : []);

        for (const streamUrl of urls) {
            if (!streamUrl) continue;

            let hostName = 'Direct';
            try {
                const h = new URL(streamUrl);
                const parts = h.hostname.replace('www.', '').split('.');
                hostName = parts[0];
                hostName = hostName.charAt(0).toUpperCase() + hostName.slice(1);
            } catch {}

            const srvKey = `${format}-${streamUrl}`;
            if (seenKeys.has(srvKey)) continue;
            seenKeys.add(srvKey);

            servers.push({
                nama: `${format} MP4`,
                namaHost: hostName,
                iframeUrl: streamUrl,
                type: 'direct',
                aktif: servers.length === 0
            });
        }
    }

    // Navigasi prev / next
    let nav_prev = null;
    let nav_next = null;
    if (targetEpNum && !isNaN(targetEpNum)) {
        const epNum = parseInt(targetEpNum, 10);
        if (epNum > 1) {
            nav_prev = `${baseUrl}?ep=${epNum - 1}`;
        }
        nav_next = `${baseUrl}?ep=${epNum + 1}`;
    }

    // Judul episode: ambil dari cache episodes jika ada
    const epsCacheKey = `nimegami_eps_v2_${baseUrl}`;
    const epsCache = cache.get(epsCacheKey);
    const seriTitle = epsCache?.judul_seri || '';
    const judulEpisode = seriTitle
        ? `${seriTitle} - Episode ${targetEpNum}`
        : `Episode ${targetEpNum || '?'}`;

    const result = { judul: judulEpisode, servers, nav_prev, nav_next };

    if (servers.length > 0) {
        cache.set(cacheKey, result);
    }

    return result;
}

/**
 * Handler Express untuk daftar episode Nimegami
 */
export async function getEpisodes(req, res) {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ status: 'error', message: "Parameter 'url' wajib diisi!" });
    }
    try {
        const data = await getNimegamiEpisodes(targetUrl);
        if (!assertAndRespondContract(res, data, 'episodes', 'Nimegami')) return;
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Nimegami Episodes Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}

/**
 * Handler Express untuk server streaming Nimegami
 */
export async function getServers(req, res) {
    const episodeUrl = req.query.url;
    if (!episodeUrl) {
        return res.status(400).json({ status: 'error', message: "Parameter 'url' wajib diisi!" });
    }
    try {
        const data = await getNimegamiServers(episodeUrl);
        if (!assertAndRespondContract(res, data, 'servers', 'Nimegami')) return;
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Nimegami Servers Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}

export async function getNimegamiLatestUpdates() {
    const { PROVIDER_URLS } = await import('../../config/providerUrls.js');
    const url = `${PROVIDER_URLS.NIMEGAMI.BASE_URL}/`;
    const { data } = await axios.post(`${SCRAPER_BASE}/scrape/nimegami/latest`, { url }, { timeout: 35000 });
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('[Nimegami] Python latest scraper mengembalikan data kosong');
    }
    return data;
}

export { cache };

// --- DYNAMIC PLUGIN SYSTEM ALIASES ---
export const scraperMeta = {
    id: 'nimegami',
    name: 'Nimegami',
    domains: ['nimegami']
};
export const scrapeEpisodes = getNimegamiEpisodes;
export const scrapeServers = getNimegamiServers;
export const scrapeLatestUpdates = getNimegamiLatestUpdates;
