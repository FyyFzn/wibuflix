import * as cheerio from 'cheerio';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchKuronimeSourcesFromHtml, mirrorToServers } from '../utils/kuronimeDecryptor.js';

/**
 * Mengambil daftar episode dari halaman detail anime Kuronime.
 * @param {string} animeUrl - URL halaman anime, e.g. https://kuronime.sbs/anime/re-zero/
 * @returns {object} - { judul_seri, cover_scraper, daftar_episode }
 */
export async function getKuronimeEpisodes(animeUrl) {
    console.log(`[Kuronime] Fetching episodes: ${animeUrl}`);

    // BUG FIX: Deklarasikan slot di luar try agar selalu bisa di-release di finally
    let $, slot;
    try {
        const fetchRes = await fetchWithCF(animeUrl, { timeout: 60000, fetchTimeout: 8000 });
        $ = fetchRes.$;
        slot = fetchRes.slot;

        const judul = ($('h1.entry-title').text() || $('h1[itemprop="name"]').text() || '').trim();
        const cover = $('img[itemprop="image"]').attr('src') || $('.thumb img').attr('src') || '';

        const daftar_episode = [];
        // Selector daftar episode di halaman anime Kuronime
        $('div.bixbox.bxcl ul li').each((_, el) => {
            const a = $(el).find('a');
            const href = a.attr('href');
            const epTitle = $(el).find('.lchx').text().trim() || $(el).find('.epl-num').text().trim() || a.text().trim();
            if (href && epTitle) {
                daftar_episode.push({
                    judul: cleanEpisodeTitle(epTitle),
                    // BUG FIX: Kembalikan URL Kuronime mentah (bukan dibungkus /api/...)
                    // agar episodes.js bisa memperlakukannya secara konsisten dalam merge
                    url: href
                });
            }
        });

        // Kuronime menampilkan episode dari terbaru ke terlama, reverse agar ascending
        daftar_episode.reverse();

        return { judul_seri: judul, cover_scraper: cover, daftar_episode };
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
        judul = judul.replace(/^Nonton\s+/i, ''); // Hapus kata "Nonton" di awal judul

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
            // 1. Stream HLS langsung (kualitas tertinggi)
            if (sources.stream?.src) {
                servers.push({
                    nama: '1080p Stream',
                    namaHost: 'KuroPlayer',
                    iframeUrl: sources.stream.src,
                    type: 'direct',
                    aktif: true,
                    headers: { Referer: 'https://kuroplayer.xyz/' }
                });
            }
            if (sources.stream_sd?.src) {
                servers.push({
                    nama: '480p Stream',
                    namaHost: 'KuroPlayer SD',
                    iframeUrl: sources.stream_sd.src,
                    type: 'direct',
                    aktif: servers.length === 0
                });
            }

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

function cleanEpisodeTitle(title) {
    if (!title) return 'Episode ?';
    if (title.toLowerCase().includes('batch')) return 'Batch';
    const ovaMatch = title.match(/(OVA|Special|SP)\s*(\d+(\.\d+)?)/i);
    if (ovaMatch) return `${ovaMatch[1].toUpperCase()} ${ovaMatch[2]}`;
    const stdMatch = title.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i);
    if (stdMatch) return `Episode ${stdMatch[1]}`;
    const fallback = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallback) return `Episode ${fallback[1]}`;
    return title;
}
