import * as cheerio from 'cheerio';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
import { releaseToPool } from '../../puppeteer/pool.js';
import { fetchKuronimeSourcesFromHtml, mirrorToServers } from '../../utils/kuronimeDecryptor.js';
import { getCache } from '../../utils/cacheManager.js';
import { formatEpisodeTitle, extractEpNumStrict, cleanSeriesTitle } from '../../utils/stringUtils.js';
import Anime from '../../models/Anime.js';
import { assertAndRespondContract } from '../../utils/contractValidator.js';

const cache = getCache('kuronime', 3600);

export const scraperMeta = {
    id: 'kuronime',
    name: 'Kuronime',
    domains: ['kuronime']
};

export const scrapeEpisodes = getKuronimeEpisodes;

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

        // AUTO-REDIRECT: Jika dipanggil menggunakan URL episode (dari latest_sync),
        // cari URL detail anime dan scrape halaman tersebut alih-alih halaman episode.
        if (!animeUrl.includes('/anime/')) {
            const extractedAnimeUrl = $('a[href*="/anime/"]').first().attr('href');
            if (extractedAnimeUrl && extractedAnimeUrl !== animeUrl) {
                console.log(`[Kuronime] URL berupa halaman episode. Redirect scraping ke: ${extractedAnimeUrl}`);
                if (slot) releaseToPool(slot);
                slot = null;
                return await getKuronimeEpisodes(extractedAnimeUrl);
            }
        }

        const judul = cleanSeriesTitle(($('h1.entry-title').text() || $('h1[itemprop="name"]').text() || '').trim());
        const cover = $('img[itemprop="image"]').attr('src') || $('.thumb img').attr('src') || '';

        const daftar_episode = [];
        const seenUrls = new Set();
        // Selector daftar episode di halaman anime Kuronime (diperluas untuk berbagai tema WordPress/eplister)
        $('div.bixbox.bxcl ul li, .eplister ul li, ul.eplister li, .lstepsiode ul li, #episode_list li, .episodelist ul li, .listeps ul li, .lastep li, div.bxcl ul li, div.epcurlast ul li, div.bixbox ul li, div.bxcl li, div[class*="eplister"] li, ul[class*="eplister"] li, div[class*="list"] ul li, ul[class*="list"] li').each((_, el) => {
            const a = $(el).find('a').first();
            const href = a.attr('href');
            const epTitle = $(el).find('.lchx').text().trim() || $(el).find('.epl-num').text().trim() || a.text().trim();
            // PENTING: Filter out URL anime detail (sidebar widget sering tertangkap oleh selector)
            if (href && epTitle && !seenUrls.has(href) && !href.includes('/anime/')) {
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
    const cacheKey = `kuro_srv_${episodeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.servers && cachedData.servers.length > 0) {
        console.log(`[Kuronime Cache Hit] ${cacheKey} (${cachedData.servers.length} servers)`);
        return cachedData;
    }

    console.log(`[Kuronime] Fetching servers: ${episodeUrl}`);

    let $, html, slot;
    let debugInfo = "OK";
    try {
        // FAST ATTEMPT: Coba HTTP GET cepat lebih dulu menggunakan CF cookie dari pool tanpa membuka browser baru
        try {
            const fastRes = await fetchWithCF(episodeUrl, { timeout: 15000, fetchTimeout: 6000, forcePuppeteer: false });
            if (fastRes?.html && !fastRes.html.includes('Just a moment') && !fastRes.html.includes('cf-browser-verification') && fastRes.html.includes('_0xa100d42aa')) {
                console.log(`[Kuronime] ✓ Fast HTTP berhasil mendapatkan token dekripsi tanpa Puppeteer.`);
                $ = fastRes.$;
                html = fastRes.html;
                slot = fastRes.slot;
            }
        } catch (fastErr) {
            console.log(`[Kuronime] Fast HTTP membutuhkan Puppeteer fallback: ${fastErr.message}`);
        }

        // FALLBACK: Jika Fast HTTP gagal/blocked/missing token, gunakan Puppeteer page penuh
        if (!html) {
            const fetchRes = await fetchWithCF(episodeUrl, { timeout: 60000, fetchTimeout: 8000, forcePuppeteer: true });
            $ = fetchRes.$;
            html = fetchRes.html;
            slot = fetchRes.slot;
        }

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

        // 3. DOM FALLBACK: Jika API animeku.org gagal dari server-side (sources kosong),
        //    coba memanfaatkan Puppeteer page yang sudah terbuka di halaman Kuronime.
        //    JavaScript client-side halaman Kuronime sendiri memanggil API yang sama (animeku.org/api/v9/sources)
        //    dan meng-render hasilnya ke download section. Kita cukup tunggu JS selesai dan baca dari DOM.
        if (servers.length === 0 && slot && slot.page && !slot.page.isClosed()) {
            console.info('[Kuronime] API sources kosong dari server-side. Mencoba DOM Fallback: menunggu client-side JS selesai render download section...');
            try {
                const page = slot.page;

                // Strategi 1: Scroll ke bawah untuk trigger lazy-load, lalu tunggu download section di-render
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                // Tunggu download section muncul (max 10 detik) — client JS akan merender setelah API call selesai
                const hasDownloadSection = await page.waitForSelector('.dlbox table a, .bixbox table a[href*="openlink"]', { timeout: 10000 })
                    .then(() => true)
                    .catch(() => false);

                if (hasDownloadSection) {
                    await new Promise(r => setTimeout(r, 1000)); // Beri waktu render tambahan

                    // Strategi 2: Ambil URL langsung dari DOM yang sudah di-render client-side JS
                    // Fungsi openlink() di browser Kuronime sudah memiliki data URL di memori JS.
                    // Kita bisa memanggil openlink dan menangkap URL via request interception.
                    const domLinks = await page.evaluate(() => {
                        const results = [];
                        const rows = document.querySelectorAll('.dlbox table tr, .bixbox table tr, table tr');
                        for (const row of rows) {
                            const resEl = row.querySelector('td:first-child');
                            const resolution = resEl ? resEl.textContent.trim() : '';
                            if (!resolution || resolution.toLowerCase().includes('vip')) continue;

                            const links = row.querySelectorAll('a');
                            for (const link of links) {
                                const hostName = link.textContent.trim();
                                if (!hostName) continue;
                                const hrefStr = link.getAttribute('href') || '';
                                const olMatch = hrefStr.match(/openlink\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/);
                                if (olMatch) {
                                    results.push({ resolution: olMatch[1], host: olMatch[2], hostLabel: hostName });
                                }
                            }
                        }
                        return results;
                    });

                    if (domLinks.length > 0) {
                        console.info(`[Kuronime] ✓ DOM Fallback: Ditemukan ${domLinks.length} download entries. Resolving URL via openlink()...`);

                        // Setup request interception untuk menangkap redirect dari openlink
                        const resolvedUrls = [];
                        const pendingResolves = new Map();

                        // Intercept navigasi: openlink() biasanya melakukan window.location atau window.open
                        const navHandler = (request) => {
                            const reqUrl = request.url();
                            if (reqUrl && !reqUrl.includes('kuronime.sbs') && !reqUrl.includes('animeku.org') && reqUrl.startsWith('http')) {
                                resolvedUrls.push(reqUrl);
                            }
                            // Abort navigasi agar page tidak berpindah
                            if (request.isNavigationRequest() && !reqUrl.includes('kuronime.sbs')) {
                                request.abort().catch(() => {});
                            } else {
                                request.continue().catch(() => {});
                            }
                        };

                        // Resolve hanya beberapa host terbaik (1080p > 720p) agar tidak terlalu lama
                        const priorityLinks = domLinks
                            .filter(d => d.resolution.includes('1080') || d.resolution.includes('720'))
                            .slice(0, 6); // Max 6 untuk hemat waktu

                        if (priorityLinks.length > 0) {
                            try {
                                await page.setRequestInterception(true);
                                page.on('request', navHandler);

                                for (const dl of priorityLinks) {
                                    resolvedUrls.length = 0; // Reset
                                    try {
                                        // Panggil openlink dari context halaman
                                        await page.evaluate((res, host) => {
                                            if (typeof window.openlink === 'function') {
                                                const origOpen = window.open;
                                                window.open = (url) => { window._lastOpenUrl = url; };
                                                try { window.openlink(res, host); } catch(e) {}
                                                window.open = origOpen;
                                            }
                                        }, dl.resolution, dl.host);

                                        await new Promise(r => setTimeout(r, 1500)); // Tunggu redirect/fetch

                                        // Cek apakah URL berhasil ditangkap
                                        const capturedUrl = await page.evaluate(() => window._lastOpenUrl || null);
                                        const finalUrl = capturedUrl || (resolvedUrls.length > 0 ? resolvedUrls[resolvedUrls.length - 1] : null);

                                        if (finalUrl && typeof finalUrl === 'string' && finalUrl.startsWith('http')) {
                                            const resLabel = dl.resolution.replace('v', '').toUpperCase();
                                            servers.push({
                                                nama: `${resLabel} MP4`,
                                                namaHost: dl.hostLabel || dl.host,
                                                iframeUrl: finalUrl,
                                                type: 'direct',
                                                aktif: servers.length === 0
                                            });
                                            console.info(`[Kuronime] ✓ DOM resolved: [${dl.host}] ${resLabel} → ${finalUrl.substring(0, 60)}...`);
                                        }
                                    } catch (olErr) {
                                        // Skip host ini
                                    }
                                }
                            } finally {
                                page.removeListener('request', navHandler);
                                await page.setRequestInterception(false).catch(() => {});
                                // Reset _lastOpenUrl
                                await page.evaluate(() => { window._lastOpenUrl = null; }).catch(() => {});
                            }
                        }

                        if (servers.length === 0) {
                            console.warn('[Kuronime] DOM Fallback: openlink resolve gagal untuk semua host. API animeku.org kemungkinan juga diblokir dari sisi browser.');
                        }
                    }
                } else {
                    console.warn('[Kuronime] DOM Fallback: Download section tidak muncul setelah scroll. Client JS mungkin juga gagal memanggil API.');
                }
            } catch (domErr) {
                console.warn('[Kuronime] DOM Fallback error:', domErr.message);
            }
        }

        if (servers.length === 0 && debugInfo === "OK") {
            debugInfo = "Sources API returned null or empty. Possibly blocked by animeku.org.";
        }

        const result = { judul, servers, nav_prev, nav_next, debug_info: debugInfo };
        if (servers.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;
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
        if (!assertAndRespondContract(res, data, 'episodes', 'Kuronime')) return;
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
        if (!assertAndRespondContract(res, data, 'servers', 'Kuronime')) return;
        res.json(data);
    } catch (err) {
        console.error('[Kuronime Servers Error]', err.message);
        res.status(500).json({ error: err.message });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function getKuronimeLatestUpdates() {
    const { PROVIDER_URLS } = await import('../../config/providerUrls.js');
    const { fetchWithCF } = await import('../../utils/scrapeHelper.js');
    const { releaseToPool } = await import('../../puppeteer/pool.js');
    const url = `${PROVIDER_URLS.KURONIME.BASE_URL}/`;
    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) return [];
        const $ = fetchRes.$;
        const seenUrls = new Set();
        $('.bixbox').first().find('article.bsu').each((_, el) => {
            const title = $(el).find('.bsuxtt h2').text().trim();
            const ep = $(el).find('.bt .ep').text().trim();
            const href = $(el).find('a').attr('href');
            if (title && ep && href && !seenUrls.has(href)) {
                seenUrls.add(href);
                updates.push({ title, status: ep, url: href });
            }
        });
    } catch (e) {
        console.error(`[Kuronime Scraper] Gagal memuat updates:`, e.message);
    } finally {
        if (slot) releaseToPool(slot);
    }
    return updates;
}


// --- DYNAMIC PLUGIN SYSTEM ALIASES ---
export const scrapeServers = getKuronimeServers;
export const scrapeLatestUpdates = getKuronimeLatestUpdates;
