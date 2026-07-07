import * as cheerio from 'cheerio';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchKuronimeSourcesFromHtml, mirrorToServers } from '../utils/kuronimeDecryptor.js';
import { getCache } from '../utils/cacheManager.js';
import { formatEpisodeTitle, extractEpNumStrict, cleanSeriesTitle } from '../utils/stringUtils.js';
import Anime from '../models/Anime.js';

const cache = getCache('kuronime', 3600);


/**
 * Mengambil daftar episode dari halaman detail anime Kuronime.
 * @param {string} animeUrl - URL halaman anime, e.g. https://kuronime.sbs/anime/re-zero/
 * @returns {object} - { judul_seri, cover_scraper, daftar_episode }
 */
export async function getKuronimeEpisodes(animeUrl) {
    const cacheKey = `kuro_eps_${animeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Kuronime Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`[Kuronime] Fetching episodes: ${animeUrl}`);

    // BUG FIX: Deklarasikan slot di luar try agar selalu bisa di-release di finally
    let $, slot;
    try {
        const fetchRes = await fetchWithCF(animeUrl, { timeout: 60000, fetchTimeout: 8000 });
        $ = fetchRes.$;
        slot = fetchRes.slot;

        const judul = cleanSeriesTitle(($('h1.entry-title').text() || $('h1[itemprop="name"]').text() || '').trim());
        const cover = $('img[itemprop="image"]').attr('src') || $('.thumb img').attr('src') || '';

        const daftar_episode = [];
        const seenUrls = new Set();
        // Selector daftar episode di halaman anime Kuronime (diperluas untuk berbagai tema WordPress/eplister)
        $('div.bixbox.bxcl ul li, .eplister ul li, ul.eplister li, .lstepsiode ul li, #episode_list li, .episodelist ul li, .listeps ul li, .lastep li, div.bxcl ul li, div.epcurlast ul li, div.bixbox ul li, div.bxcl li, div[class*="eplister"] li, ul[class*="eplister"] li, div[class*="list"] ul li, ul[class*="list"] li').each((_, el) => {
            const a = $(el).find('a').first();
            const href = a.attr('href');
            const epTitle = $(el).find('.lchx').text().trim() || $(el).find('.epl-num').text().trim() || a.text().trim();
            if (href && epTitle && !seenUrls.has(href)) {
                seenUrls.add(href);
                daftar_episode.push({
                    judul: formatEpisodeTitle(epTitle),
                    // BUG FIX: Kembalikan URL Kuronime mentah (bukan dibungkus /api/...)
                    // agar episodes.js bisa memperlakukannya secara konsisten dalam merge
                    url: href
                });
            }
        });

        // Kuronime menampilkan episode dari terbaru ke terlama, reverse agar ascending
        daftar_episode.reverse();

        const result = { judul_seri: judul, cover_scraper: cover, daftar_episode };
        if (daftar_episode.length > 0) {
            cache.set(cacheKey, result);
        } else {
            console.warn(`[Kuronime] Peringatan: 0 episode ditemukan untuk ${animeUrl}. Hasil tidak disimpan ke cache agar dapat dicoba ulang.`);
        }
        return result;
    } finally {
        // Selalu release slot, bahkan jika fetchWithCF throw
        if (slot) releaseToPool(slot);
    }
}

/**
 * Mengambil daftar server streaming/download dari halaman episode Kuronime.
 * Menggunakan dekripsi AES langsung, tanpa Puppeteer.
 * @param {string} episodeUrl - URL halaman episode
 * @returns {object} - { judul, servers, nav_prev, nav_next }
 */
export async function getKuronimeServers(episodeUrl) {
    console.log(`[Kuronime] Fetching servers: ${episodeUrl}`);

    // BUG FIX: Deklarasikan slot di luar try agar selalu bisa di-release di finally
    let $, html, slot;
    let debugInfo = "OK";
    try {
        const fetchRes = await fetchWithCF(episodeUrl, { timeout: 60000, fetchTimeout: 8000 });
        $ = fetchRes.$;
        html = fetchRes.html;
        slot = fetchRes.slot;

        if (!html) debugInfo = "HTML is entirely empty.";
        else if (html.includes('Just a moment') || html.includes('cf-browser-verification')) debugInfo = "Blocked by Cloudflare Captcha Page";
        else if (!html.includes('_0xa100d42aa')) debugInfo = "Token _0xa100d42aa not found in HTML. HTML snippet: " + html.substring(0, 300);

        // Judul episode
        let judul = ($('h1.entry-title').text() || $('title').text().replace(/[-–|].*$/, '')).trim();
        judul = cleanSeriesTitle(judul.replace(/^Nonton\s+/i, '')); // Hapus kata "Nonton" di awal judul dan bersihkan SEO text

        // Navigasi prev/next
        let nav_prev = null, nav_next = null;
        $('.naveps a').each((_, el) => {
            const cls = $(el).attr('class') || '';
            const href = $(el).attr('href');
            if (cls.includes('prev') || $(el).text().toLowerCase().includes('prev')) nav_prev = href;
            if (cls.includes('next') || $(el).text().toLowerCase().includes('next')) nav_next = href;
        });

        // Ambil sources via dekripsi AES, bawa Puppeteer page untuk fallback CF
        const sources = await fetchKuronimeSourcesFromHtml(html, slot ? slot.page : null);

        const servers = [];

        if (sources) {
            // 1. Stream HLS langsung (KuroPlayer dilewati karena sering 404/expired di FFmpeg & lambat)
            // Hanya gunakan mirror download/embed yang stabil dan cepat

            // 2. Mirror download/embed dari berbagai host
            if (sources.mirror) {
                const mirrorServers = mirrorToServers(sources.mirror);
                mirrorServers.forEach(s => {
                    if (servers.length > 0) s.aktif = false;
                    servers.push(s);
                });
            }
        }

        if (servers.length === 0 && debugInfo === "OK") {
            debugInfo = "Sources API returned null or empty. Possibly blocked by animeku.org.";
        }

        return { judul, servers, nav_prev, nav_next, debug_info: debugInfo };
    } catch (err) {
        return { judul: "Error", servers: [], debug_info: err.message };
    } finally {
        // Selalu release slot
        if (slot) releaseToPool(slot);
    }
}

/**
 * Handler Express: GET /api/kuronime/episodes?url=...
 */
export async function handleGetEpisodes(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: 'Parameter url wajib diisi' });
        const data = await getKuronimeEpisodes(url);
        res.json(data);
    } catch (err) {
        console.error('[Kuronime Episodes Error]', err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * Handler Express: GET /api/kuronime/servers?url=...
 */
export async function handleGetServers(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: 'Parameter url wajib diisi' });
        const data = await getKuronimeServers(url);
        res.json(data);
    } catch (err) {
        console.error('[Kuronime Servers Error]', err.message);
        res.status(500).json({ error: err.message });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
