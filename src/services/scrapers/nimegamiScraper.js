import { releaseToPool } from '../../puppeteer/pool.js';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
import * as cheerio from 'cheerio';
import { getCache } from '../../utils/cacheManager.js';
import Anime from '../../models/Anime.js';
import { cleanSeriesTitle } from '../../utils/stringUtils.js';
import { assertAndRespondContract } from '../../utils/contractValidator.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';

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

    console.log(`\n[Nimegami Episodes] Fetching: ${cleanUrl}`);

    let slot;
    try {
        const fetchRes = await fetchWithCF(cleanUrl, { fetchTimeout: 10000 });
        slot = fetchRes.slot;
        const $ = fetchRes.$;
        const html = fetchRes.html;

        if (html === '404_NOT_FOUND') {
            throw new Error("Target URL returned 404");
        }

        // Ambil judul seri dari h1.title (paling akurat)
        let rawTitle = $('h1.title').first().text().trim() ||
                       $('meta[property="og:title"]').attr('content') ||
                       cleanSeriesTitle($('title').text() || '');
        rawTitle = rawTitle
            .replace(/\s*-\s*Nimegami.*$/i, '')
            .replace(/\s*:\s*Episode\s*\d+.*$/i, '')
            .replace(/\s+Sub\s+Indo.*$/i, '')
            .replace(/\s+BD\s+Sub.*$/i, '')
            .replace(/\s*:\s*Episode\s+\d+\s*[-\u2013]\s*\d+.*$/i, '')
            .trim();
        rawTitle = cleanSeriesTitle(rawTitle);

        const coverImg =
            $('meta[property="og:image"]').attr('content') ||
            $('.coverthumbnail img, .thumbnail img').first().attr('src') || '';

        const daftar_episode = [];

        // === SELECTOR UTAMA ===
        // Semua episode ada dalam li.select-eps di div.list_eps_stream
        $('div.list_eps_stream li.select-eps, .streaming_eps_box li.select-eps').each((_, el) => {
            const $el = $(el);
            const epText = $el.text().trim();          // "Episode 1", "Episode 2", dst.
            const epId   = $el.attr('id') || '';       // "play_eps_1"
            const dataAttr = $el.attr('data') || '';   // base64 JSON stream URLs

            // Ekstrak nomor episode dari attribute id (lebih reliabel dari teks)
            let epNum = null;
            const idMatch = epId.match(/play_eps_(\d+)/i);
            if (idMatch) {
                epNum = parseInt(idMatch[1], 10);
            } else {
                const textMatch = epText.match(/(?:episode|ep)\s*(\d+)/i);
                if (textMatch) epNum = parseInt(textMatch[1], 10);
            }

            if (epNum === null) return; // Skip jika tidak ada nomor episode (mis. batch/OVA tanpa nomor)

            // URL virtual: baseUrl?ep=N — untuk kompatibilitas dengan sistem Virtual Routing
            const episodeVirtualUrl = `${cleanUrl.replace(/\/$/, '')}?ep=${epNum}`;

            // Pre-populate cache per-episode dari data attribute (agar getServers tidak perlu fetch ulang)
            if (dataAttr) {
                const streamData = decodeEpisodeData(dataAttr);
                if (streamData && Array.isArray(streamData) && streamData.length > 0) {
                    const baseUrlNormalized = cleanUrl.replace(/\/$/, '');
                    cache.set(`nimegami_ep_data_${baseUrlNormalized}_ep${epNum}`, streamData);
                }
            }

            daftar_episode.push({
                judul: epText || `Episode ${epNum}`,
                url: episodeVirtualUrl
            });
        });

        // === SELECTOR KEDUA (Fallback untuk postingan Batch / Download Only) ===
        if (daftar_episode.length === 0) {
            $('h4, h3, .download_box .title, .batch-dlcuy .title').each((_, headerEl) => {
                const epText = $(headerEl).text().trim();
                const epNumMatch = epText.match(/(?:episode|ep)\s*(\d+)/i);
                
                if (epNumMatch && !epText.toLowerCase().includes('batch')) {
                    const epNum = parseInt(epNumMatch[1], 10);
                    
                    const ulEl = $(headerEl).next('ul');
                    if (ulEl.length > 0) {
                        const streamData = [];
                        ulEl.find('li').each((_, liEl) => {
                            const format = $(liEl).find('strong').text().trim().replace(/p$/i, 'P'); 
                            const urls = [];
                            $(liEl).find('a').each((_, aEl) => {
                                urls.push($(aEl).attr('href'));
                            });
                            if (urls.length > 0) {
                                streamData.push({ format, url: urls });
                            }
                        });
                        
                        if (streamData.length > 0) {
                            const baseUrlNormalized = cleanUrl.replace(/\/$/, '');
                            cache.set(`nimegami_ep_data_${baseUrlNormalized}_ep${epNum}`, streamData);
                            
                            // Hindari duplikasi jika format HTML berulang
                            if (!daftar_episode.find(ep => ep.url === `${baseUrlNormalized}?ep=${epNum}`)) {
                                daftar_episode.push({
                                    judul: epText,
                                    url: `${baseUrlNormalized}?ep=${epNum}`
                                });
                            }
                        }
                    }
                }
            });
        }

        // Urutkan ascending berdasarkan nomor episode
        daftar_episode.sort((a, b) => {
            const numA = parseInt(a.url.match(/[?&]ep=(\d+)/)?.[1] || '0', 10);
            const numB = parseInt(b.url.match(/[?&]ep=(\d+)/)?.[1] || '0', 10);
            return numA - numB;
        });

        const result = { judul_seri: rawTitle, cover_scraper: coverImg, daftar_episode };

        if (daftar_episode.length > 0) {
            cache.set(cacheKey, result);
        } else {
            console.warn(`[Nimegami] Peringatan: 0 episode ditemukan di ${cleanUrl}. Tidak di-cache.`);
        }

        return result;
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
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
    const { fetchWithCF } = await import('../../utils/scrapeHelper.js');
    const { releaseToPool } = await import('../../puppeteer/pool.js');
    const { cleanSeriesTitle } = await import('../../utils/stringUtils.js');
    const url = `${PROVIDER_URLS.NIMEGAMI.BASE_URL}/anime-terbaru-sub-indo/`;
    let fetchRes, slot;
    const updatesMap = new Map();
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) return [];
        const $ = fetchRes.$;
        const ignoreWords = ['/category/', '/tag/', '/list', '/jadwal', '/genre', 'wp-content', 'javascript:', 'telegram', 'facebook', 'twitter', 'instagram', 'discord', '/page/', '/anime-terbaru', '/live-action', '/drama-jepang', '/dorama', '/jdrama', '/j-drama', '/type', '/seasons', '/streaming', '/ongoing', '/completed', '/movie-list', '/author/', '/about', '/contact', '/privacy', '/disclaimer', '/dmca', '/donasi'];
        const ignoreTitles = ['anime list', 'live action', 'j-drama', 'jdrama', 'drama jepang', 'anime terbaru', 'jadwal rilis', 'streaming list', 'baca komik', 'type', 'seasons', 'genre', 'home', 'beranda', 'ongoing', 'completed', 'next', 'prev', 'previous', 'dramaid'];
        $('.content, #main, .main, .post, article, .list-anime').find('a').each((_, el) => {
            if ($(el).closest('nav, header, footer, .sidebar, .menu, .nav, ul.menu, li.menu-item').length > 0) return;
            const href = $(el).attr('href');
            let text = $(el).text().replace(/\s+/g, ' ').trim();
            if (!href || !href.startsWith('http') || ignoreWords.some(w => href.toLowerCase().includes(w)) || href === `${PROVIDER_URLS.NIMEGAMI.BASE_URL}/`) return;
            if (ignoreTitles.some(t => text.toLowerCase() === t || text.toLowerCase().includes(t))) return;
            if (href.includes(new URL(PROVIDER_URLS.NIMEGAMI.BASE_URL).hostname + '/')) {
                if (!updatesMap.has(href)) updatesMap.set(href, { title: null, status: null });
                const entry = updatesMap.get(href);
                if (/eps?\.?\s*\d+/i.test(text)) {
                    const match = text.match(/eps?\.?\s*(\d+)/i);
                    if (match) entry.status = `Eps ${match[1]}`;
                } else if (text.length > 2 && !text.toLowerCase().includes('belum update')) {
                    entry.title = cleanSeriesTitle(text);
                }
            }
        });
    } catch (e) {
        console.error(`[Nimegami Scraper] Gagal memuat updates:`, e.message);
    } finally {
        if (slot) releaseToPool(slot);
    }
    const updates = [];
    for (const [url, data] of updatesMap.entries()) {
        if (data.title && data.status) updates.push({ title: data.title, status: data.status, url });
    }
    return updates;
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
