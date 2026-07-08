import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import * as cheerio from 'cheerio';
import { getCache } from '../utils/cacheManager.js';
import Anime from '../models/Anime.js';
import { cleanSeriesTitle } from '../utils/stringUtils.js';

const cache = getCache('nimegami', 3600);

/**
 * Mengikis daftar episode dari halaman utama anime Nimegami
 * Menerapkan Virtual Episode Routing (?ep=X) dan 3-Layer Smart Episode vs Batch Filtering.
 */
export async function getNimegamiEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    // Hilangkan parameter ep jika ada, tapi pertahankan dl=X untuk pagination
    let cleanUrl = targetUrl;
    try {
        const u = new URL(targetUrl);
        u.searchParams.delete('ep');
        cleanUrl = u.toString();
    } catch {
        cleanUrl = targetUrl.split('?')[0];
    }
    const cacheKey = `nimegami_eps_${cleanUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Nimegami Episodes Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`\n[Nimegami Fast Fetch] ${cleanUrl}`);

    let slot;
    try {
        const fetchRes = await fetchWithCF(cleanUrl, { fetchTimeout: 10000 });
        slot = fetchRes.slot;
        const $ = fetchRes.$;
        const html = fetchRes.html;

        if (html === '404_NOT_FOUND') {
            throw new Error("Target URL returned 404");
        }

        let rawTitle = cleanSeriesTitle($('title').text() || '');
        rawTitle = rawTitle.replace(/\s*:\s*Episode\s*\d+.*$/i, '').replace(/\s*-\s*Nimegami.*$/i, '').trim();

        const coverImg = 
            $('meta[property="og:image"]').attr('content') ||
            $('.thumbnail img, .cover img, .entry-content img').first().attr('src') || '';

        const daftar_episode = [];
        const seenEpNums = new Set();
        const baseSlugUrl = cleanUrl.replace(/\/$/, '');
        const visitedPages = new Set([baseSlugUrl]);
        const pagesQueue = [];

        const checkAndQueuePagination = ($cheerio) => {
            $cheerio('a').each((_, el) => {
                let link = $cheerio(el).attr('href');
                if (!link || link.startsWith('#') || link.startsWith('javascript:')) return;

                if (link.includes('dl=')) {
                    const match = link.match(/dl=(\d+)/i);
                    if (match) {
                        const pageNum = parseInt(match[1], 10);
                        if (pageNum >= 2 && pageNum <= 50) {
                            const dlUrl = `${cleanUrl}?dl=${pageNum}`;
                            if (!visitedPages.has(dlUrl)) {
                                pagesQueue.push(dlUrl);
                                visitedPages.add(dlUrl);
                            }
                        }
                    }
                    return;
                }

                if (link.startsWith('/')) {
                    link = `https://nimegami.id${link}`;
                } else if (!link.startsWith('http')) {
                    link = `${baseSlugUrl}/${link}`;
                }
                const cleanLink = link.split('?')[0].replace(/\/$/, '');
                if (cleanLink.startsWith(baseSlugUrl) && cleanLink !== baseSlugUrl && !visitedPages.has(cleanLink)) {
                    if (/\/(?:page\/)?(\d+)$/i.test(cleanLink)) {
                        const match = cleanLink.match(/\/(?:page\/)?(\d+)$/i);
                        const pageNum = parseInt(match[1], 10);
                        if (pageNum >= 2 && pageNum <= 50) {
                            pagesQueue.push(`${cleanLink}/`);
                            visitedPages.add(cleanLink);
                        }
                    }
                }
            });
        };

        checkAndQueuePagination($);

        // 3-Layer Smart Filtering: Lapis 1 (Label & Heading RegEx Filter)
        $('.download, .sorasdd, .list-download, .entry-content').find('h2, h3, h4, h5, strong, b, p, tr').each((_, el) => {
            const labelText = $(el).text().trim();

            if (/batch|complete|paket|all\s*eps|01\s*-\s*\d+|1\s*-\s*\d+|zip|rar/i.test(labelText)) {
                return;
            }

            const epMatch = labelText.match(/(?:episode|ep|eps)\s*(\d+)/i);
            if (epMatch) {
                const epNum = parseInt(epMatch[1], 10);
                if (!seenEpNums.has(epNum)) {
                    seenEpNums.add(epNum);
                    const separator = cleanUrl.includes('?') ? '&' : '?';
                    daftar_episode.push({
                        judul: `Episode ${epNum}`,
                        url: `${cleanUrl}${separator}ep=${epNum}`
                    });
                }
            }
        });

        // Looping untuk mengambil episode dari halaman lanjutan jika anime memiliki banyak episode (misal Inazuma Eleven)
        let maxPages = 20;
        while (pagesQueue.length > 0 && maxPages > 0) {
            maxPages--;
            const nextPageUrl = pagesQueue.shift();
            console.log(`[Nimegami Episodes Pagination] Mengambil halaman lanjutan: ${nextPageUrl}`);
            let nextSlot;
            try {
                const nextRes = await fetchWithCF(nextPageUrl, { fetchTimeout: 10000 });
                nextSlot = nextRes.slot;
                const next$ = nextRes.$;

                checkAndQueuePagination(next$);

                next$('.download, .sorasdd, .list-download, .entry-content').find('h2, h3, h4, h5, strong, b, p, tr').each((_, el) => {
                    const labelText = next$(el).text().trim();
                    if (/batch|complete|paket|all\s*eps|01\s*-\s*\d+|1\s*-\s*\d+|zip|rar/i.test(labelText)) {
                        return;
                    }
                    const epMatch = labelText.match(/(?:episode|ep|eps)\s*(\d+)/i);
                    if (epMatch) {
                        const epNum = parseInt(epMatch[1], 10);
                        if (!seenEpNums.has(epNum)) {
                            seenEpNums.add(epNum);
                            const separator = nextPageUrl.includes('?') ? '&' : '?';
                            daftar_episode.push({
                                judul: `Episode ${epNum}`,
                                url: `${nextPageUrl}${separator}ep=${epNum}`
                            });
                        }
                    }
                });
            } catch (err) {
                console.warn(`[Nimegami Episodes Pagination] Gagal memuat ${nextPageUrl}:`, err.message);
            } finally {
                if (nextSlot) releaseToPool(nextSlot);
            }
        }

        // Urutkan episode dari yang awal hingga akhir atau sebaliknya (biasanya descending atau ascending)
        daftar_episode.sort((a, b) => {
            const numA = parseInt(a.judul.replace(/\D/g, ''), 10) || 0;
            const numB = parseInt(b.judul.replace(/\D/g, ''), 10) || 0;
            return numA - numB;
        });

        const result = { judul_seri: rawTitle, cover_scraper: coverImg, daftar_episode };

        // Lapis 3: Zero-Data & Strict-Caching Guard
        if (daftar_episode.length > 0) {
            cache.set(cacheKey, result);
        } else {
            console.warn(`[Nimegami] Peringatan: 0 episode tunggal ditemukan di ${cleanUrl}. Hasil tidak disimpan ke cache agar dapat di-retry/fallback.`);
        }

        return result;
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
}

/**
 * Mengikis server streaming/download untuk episode tertentu berdasarkan Virtual Routing (?ep=X)
 */
export async function getNimegamiServers(episodeUrl) {
    if (!episodeUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `nimegami_srv_${episodeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    const urlObj = new URL(episodeUrl);
    const targetEpNum = urlObj.searchParams.get('ep');
    urlObj.searchParams.delete('ep');
    const baseUrl = urlObj.toString();

    console.log(`[Nimegami] Fetching servers for Ep ${targetEpNum} from: ${baseUrl}`);

    let slot;
    try {
        const fetchRes = await fetchWithCF(baseUrl, { fetchTimeout: 10000 });
        slot = fetchRes.slot;
        const $ = fetchRes.$;

        let judul = cleanSeriesTitle($('title').text() || '');
        if (targetEpNum) {
            judul = `${judul} - Episode ${targetEpNum}`;
        }

        const servers = [];
        const seenServers = new Set();

        const allowedHostKeywords = ['kraken', 'pdrain', 'vidhide', 'filedon', 'gofile', 'acefile', 'mega', 'pucuk', 'pixeldrain', 'wibufile', 'filemoon', 'filelions', 'moonplayer', 'mirrorupload', 'desudrive', 'ondrive', 'mirror', 'zippyshare', 'filesim', 'hxfile', 'mp4upload', 'racaty', 'cloudmail', 'vstream', 'streamhide', 'yourupload', 'filecloud', 'desustream', 'berkasdrive', 'drive', 'google', 'anonfiles', 'bayfiles', 'letupload', 'uptobox', 'mediafire', 'streamhub', 'voe', 'streamsb', 'uqload', 'odrive', 'sendwire', 'mixdrop', 'dood', 'streamtape', 'abysscdn', 'kurodrive', 'solidfiles', 'tusfiles', 'usercloud', 'userscloud', 'ulozto', 'clicknupload', 'hexupload', 'rapidgator', 'turbobit', 'nitroflare', 'filerio', 'dailyuploads', 'downace', 'filescdn', 'indishare', 'bdupload', 'uptostream', 'streamango', 'openload', 'verystream', 'clipwatching', 'vidoza', 'vidia', 'filechan', 'letsupload', 'yandex', 'mail.ru', 'dropapk', 'megaup', 'otakudesu', 'samehadaku', 'kuronime', 'nanime', 'embed', 'player', 'video', 'stream'];
        const blockedKeywords = /batch|zip|rar|7z|gdrive|mega\.nz|zippyshare|mediafire|google/i;

        $('.download, .sorasdd, .list-download, .entry-content, .box-download, #LinkDownload, .list_dl').find('h2, h3, h4, h5, strong, b, p, tr, li, div').each((_, el) => {
            const text = $(el).text().trim();
            if (/batch|01\s*-\s*\d+/i.test(text)) return;

            const epMatch = text.match(/(?:episode|ep|eps)\s*(\d+)/i);
            if (epMatch && (!targetEpNum || parseInt(epMatch[1], 10) === parseInt(targetEpNum, 10))) {
                let linkElements = $(el).find('a');
                if (linkElements.length === 0) {
                    linkElements = $(el).nextUntil('h1, h2, h3, h4, h5, hr, tr').find('a');
                }
                if (linkElements.length === 0 && $(el).parent().length > 0) {
                    linkElements = $(el).parent().find('a');
                }

                linkElements.each((__, aEl) => {
                    const href = $(aEl).attr('href');
                    const linkText = $(aEl).text().trim();

                    if (!href || href.startsWith('#') || blockedKeywords.test(href) || blockedKeywords.test(linkText)) {
                        return;
                    }

                    const hostMatch = allowedHostKeywords.find(h => href.toLowerCase().includes(h) || linkText.toLowerCase().includes(h));
                    if (hostMatch) {
                        let resText = 'MP4';
                        const parentText = $(aEl).parent().text() || '';
                        if (parentText.includes('1080p') || linkText.includes('1080p')) resText = '1080p';
                        else if (parentText.includes('720p') || linkText.includes('720p')) resText = '720p';
                        else if (parentText.includes('480p') || linkText.includes('480p')) resText = '480p';
                        else if (parentText.includes('360p') || linkText.includes('360p')) resText = '360p';

                        let normalizedHref = href;
                        const isEmbedHost = ['filemoon', 'filelions', 'moonplayer', 'wibufile'].some(h => hostMatch.includes(h) || linkText.toLowerCase().includes(h));
                        if (isEmbedHost && normalizedHref.match(/\/f\/[^/]+\/?$/)) {
                            normalizedHref = normalizedHref.replace(/\/f\//, '/e/');
                        }
                        const label = linkText.length > 2 && !/^\d+p$/i.test(linkText) ? linkText : hostMatch.charAt(0).toUpperCase() + hostMatch.slice(1);
                        const srvKey = `${resText}-${label}-${normalizedHref}`;
                        if (!seenServers.has(srvKey)) {
                            seenServers.add(srvKey);
                            servers.push({
                                nama: `${resText} MP4`,
                                namaHost: label,
                                iframeUrl: normalizedHref,
                                type: 'direct',
                                aktif: servers.length === 0
                            });
                        }
                    }
                });
            }
        });

        let nav_prev = null;
        let nav_next = null;
        if (targetEpNum && !isNaN(targetEpNum)) {
            const epNum = parseInt(targetEpNum, 10);
            if (epNum > 1) {
                const uPrev = new URL(baseUrl);
                uPrev.searchParams.set('ep', epNum - 1);
                nav_prev = uPrev.toString();
            }
            const uNext = new URL(baseUrl);
            uNext.searchParams.set('ep', epNum + 1);
            nav_next = uNext.toString();
        }

        const result = { judul, servers, nav_prev, nav_next };
        if (servers.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
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
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Nimegami Servers Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}

export { cache };
