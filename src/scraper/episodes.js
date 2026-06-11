import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { enrichWithMAL } from '../utils/malEnrichment.js';
import * as cheerio from 'cheerio';
import { getCache } from '../utils/cacheManager.js';

const cache = getCache('episodes', 3600);

export async function getEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `eps_${targetUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Episodes Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`\n[Episodes Fast Fetch] ${targetUrl}`);

    let slot;
    try {
        const fetchRes = await fetchWithCF(targetUrl, { fetchTimeout: 6000 });
        slot = fetchRes.slot;
        const $ = fetchRes.$;
        const html = fetchRes.html;

        if (html === '404_NOT_FOUND') {
            throw new Error("Target URL returned 404");
        }

        const rawTitle = ($('title').text() || '').replace(/[-–|].*$/, '').trim();
        const daftar_episode = [];

        const coverImg = 
            $('meta[property="og:image"]').attr('content') ||
            $('.thumb img, .thumbook img').attr('src') || '';

        const seenUrls = new Set();
        $('.lstepsiode ul li, .episodelist ul li, .listeps ul li').each((_, el) => {
            let epLink = $(el).find('.epsleft a').first();
            if (!epLink.length) epLink = $(el).find('a').first();
            
            let epDate = $(el).find('.date').first();
            if (!epDate.length) epDate = $(el).find('.epsright').first();

            if (epLink.length && epLink.attr('href')) {
                const title = epLink.text().trim();
                const url = epLink.attr('href');
                
                // Abaikan episode batch
                if (title.toLowerCase().includes('batch')) return;
                
                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    daftar_episode.push({
                        judul: title,
                        url: url,
                        tanggal: epDate.length ? epDate.text().trim() : ''
                    });
                }
            }
        });

        // Fallback untuk Movie/Spesial (jika daftar episode kosong, tetapi ada tombol download)
        if (daftar_episode.length === 0) {
            const downloadLink = $('.download-eps a, .dl-box a, .soraddlx a').first();
            if (downloadLink.length && downloadLink.attr('href')) {
                daftar_episode.push({
                    judul: rawTitle || 'Full Movie / Episode Spesial',
                    url: targetUrl, // Kirim URL saat ini, server akan parsing iframenya
                    tanggal: '-',
                });
            } else if ($('.player-area iframe, #player iframe, .pd-expand iframe').length > 0) {
                // Ada iframe video langsung
                daftar_episode.push({
                    judul: rawTitle || 'Full Movie / Episode Spesial',
                    url: targetUrl,
                    tanggal: '-',
                });
            }
        }

        const result = { judul_seri: rawTitle, cover_scraper: coverImg, daftar_episode };

        // ── MAL/TMDB Enrichment ──
        const { mal, enrichedEpisodes } = await enrichWithMAL(result.judul_seri, result.daftar_episode, result.cover_scraper);

        const enriched = {
            judul_seri: result.judul_seri,
            cover_scraper: result.cover_scraper,
            daftar_episode: enrichedEpisodes,
            mal: mal
        };

        cache.set(cacheKey, enriched);
        return enriched;
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
}

export { cache };
