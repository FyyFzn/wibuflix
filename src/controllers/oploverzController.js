import { acquireFromPool, releaseToPool } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';
import { getCache } from '../utils/cacheManager.js';
import { formatEpisodeTitle, extractEpNumStrict, cleanSeriesTitle } from '../utils/stringUtils.js';
import { assertAndRespondContract } from '../utils/contractValidator.js';
import { PROVIDER_URLS } from '../config/providerUrls.js';

const cache = getCache('oploverz', 3600);

export async function getOploverzEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `oploverz_eps_${targetUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Oploverz Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`\n[Oploverz] Fetching episodes via Puppeteer: ${targetUrl}`);
    let slot;
    try {
        slot = await acquireFromPool();
        const page = slot.page;
        
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const html = await page.content();
        const $ = cheerio.load(html);

        let rawTitle = $('h1').first().text().trim() || $('title').text().replace(/Oploverz/i, '').replace(/subtitle indonesia/i, '').trim();
        const judul = cleanSeriesTitle(rawTitle);
        
        const coverImg = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';

        const daftar_episode = [];
        const seenEpNums = new Set();
        
        $('a[href^="/series/"][href*="/episode/"]').each((_, el) => {
            const epTitleRaw = $(el).text().trim() || $(el).attr('title') || 'Episode';
            const epHref = $(el).attr('href');
            
            if (epHref && !epTitleRaw.toLowerCase().includes('batch')) {
                const epUrl = `${PROVIDER_URLS.OPLOVERZ.BASE_URL}${epHref}`;
                // Coba ekstrak episode dari URL jika teks tidak mengandung angka jelas


                const epNumFromUrlMatch = epHref.match(/\/episode\/(\d+(\.\d+)?)/i);
                const epNum = extractEpNumStrict(epTitleRaw) || (epNumFromUrlMatch ? parseFloat(epNumFromUrlMatch[1]) : null);
                
                if (epNum !== null && !seenEpNums.has(epNum)) {
                    seenEpNums.add(epNum);
                    
                    let finalEpTitle = epTitleRaw;
                    const lowerTitle = epTitleRaw.toLowerCase();
                    const isGeneric = lowerTitle.includes('sekarang') || 
                                      lowerTitle.includes('nonton') || 
                                      lowerTitle.includes('tonton') || 
                                      lowerTitle.includes('play') ||
                                      !/\d/.test(epTitleRaw);
                    
                    if (isGeneric) {
                        finalEpTitle = `Episode ${epNum}`;
                    }

                    daftar_episode.push({
                        judul: formatEpisodeTitle(finalEpTitle !== 'Episode' ? finalEpTitle : `Episode ${epNum}`),
                        url: epUrl,
                        num: epNum
                    });
                }
            }
        });

        // Urutkan episode dari yang terlama ke terbaru (Ascending)
        daftar_episode.sort((a, b) => a.num - b.num);

        const cleanEpisodes = daftar_episode.map(({ judul, url }) => ({ judul, url }));
        const result = { judul_seri: judul, cover_scraper: coverImg, daftar_episode: cleanEpisodes };
        
        if (cleanEpisodes.length > 0) {
            cache.set(cacheKey, result);
        } else {
            console.warn(`[Oploverz] Peringatan: 0 episode ditemukan di ${targetUrl}`);
        }

        return result;
    } catch (err) {
        console.error(`[Oploverz Episodes Error] ${targetUrl}:`, err.message);
        return { judul_seri: "Error", cover_scraper: "", daftar_episode: [] };
    } finally {
        if (slot) releaseToPool(slot);
    }
}

export async function getOploverzServers(episodeUrl) {
    if (!episodeUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `oploverz_srv_${episodeUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    console.log(`[Oploverz] Fetching servers via Puppeteer: ${episodeUrl}`);
    let slot;
    try {
        slot = await acquireFromPool();
        const page = slot.page;
        
        await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const html = await page.content();
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
    } finally {
        if (slot) releaseToPool(slot);
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
