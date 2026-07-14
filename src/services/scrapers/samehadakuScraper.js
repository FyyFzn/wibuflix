import { releaseToPool } from '../../puppeteer/pool.js';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
import * as cheerio from 'cheerio';
import { getCache } from '../../utils/cacheManager.js';
import Anime from '../../models/Anime.js';
import { extractEpNumStrict, cleanSeriesTitle } from '../../utils/stringUtils.js';

const cache = getCache('episodes', 3600);

export async function getSamehadakuEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");

    const cacheKey = `eps_${targetUrl}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
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

        const rawTitle = cleanSeriesTitle($('title').text() || '');
        const daftar_episode = [];

        const coverImg = 
            $('meta[property="og:image"]').attr('content') ||
            $('.thumb img, .thumbook img').attr('src') || '';

        const cleanBaseTitle = rawTitle.toLowerCase().replace(/season\s*\d+/i, '').replace(/subtitle\s*indonesia/i, '').trim();
        const seasonMatch = rawTitle.match(/season\s*(\d+)/i);
        const currentSeason = seasonMatch ? parseInt(seasonMatch[1]) : 1;

        const seenUrls = new Set();
        $('.lstepsiode ul li, .episodelist ul li, .listeps ul li').each((_, el) => {
            let epLink = $(el).find('.epsleft a').first();
            if (!epLink.length) epLink = $(el).find('a').first();

            if (epLink.length && epLink.attr('href')) {
                let title = epLink.text().trim();
                const url = epLink.attr('href');
                
                // Abaikan episode batch
                if (title.toLowerCase().includes('batch')) return;

                // Cegah masuknya episode dari season berbeda yang diselipkan Samehadaku di sidebar
                const epSeasonMatch = title.match(/season\s*(\d+)/i);
                if (epSeasonMatch) {
                    const epSeason = parseInt(epSeasonMatch[1]);
                    if (epSeason !== currentSeason) return; // Beda season, buang!
                } else if (currentSeason > 1 && title.toLowerCase().includes(cleanBaseTitle) && !title.toLowerCase().includes('season')) {
                    // Kadang ada "Oshi no Ko Episode 1", ini biasanya season 1. Jika kita di Season > 1, ini kemungkinan nyasar.
                    // Tapi agar aman, kita biarkan saja kalau tidak eksplisit menyebut "Season X".
                }

                // Bersihkan nama episode dengan membuang judul seri agar tidak kepanjangan
                // Contoh: "Oshi no Ko Season 3 Episode 11 END" -> "Episode 11 END"
                let shortTitle = title;
                // Buang "Oshi no Ko Season 3"
                const titleToStrip = rawTitle.replace(/subtitle\s*indonesia/gi, '').trim();
                const regexStrip = new RegExp(titleToStrip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                const stripped = shortTitle.replace(regexStrip, '').trim();
                
                // Hanya pakai hasil stripping jika masih mengandung penanda episode (angka / OVA / SP dll.)
                // Jika tidak ada (misal sisa cuma "Moment"), kembalikan ke judul asli
                const hasEpisodeMarker = /\d|OVA|OAD|Special|SP|Movie|Film/i.test(stripped);
                if (stripped && stripped.length >= 2 && hasEpisodeMarker) {
                    shortTitle = stripped;
                }
                // Kalau setelah dihapus malah kosong atau tidak bermakna, kembalikan ke awal
                if (!shortTitle || shortTitle.length < 2) shortTitle = title;
                
                // Pastikan diawali kapital
                shortTitle = shortTitle.charAt(0).toUpperCase() + shortTitle.slice(1);

                if (!seenUrls.has(url)) {
                    seenUrls.add(url);
                    daftar_episode.push({
                        judul: shortTitle,
                        url: url
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
                    url: targetUrl // Kirim URL saat ini, server akan parsing iframenya
                });
            } else if ($('.player-area iframe, #player iframe, .pd-expand iframe').length > 0) {
                // Ada iframe video langsung
                daftar_episode.push({
                    judul: rawTitle || 'Full Movie / Episode Spesial',
                    url: targetUrl
                });
            }
        }

        const result = { judul_seri: rawTitle, cover_scraper: coverImg, daftar_episode };

        // Jangan cache jika episode kosong — bisa jadi Cloudflare masih memblokir, bukan episode memang 0
        if (daftar_episode.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
}

export async function getSamehadakuLatestUpdates() {
    const { PROVIDER_URLS } = await import('../../config/providerUrls.js');
    const url = `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`;
    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) return [];
        const $ = fetchRes.$;
        $('.post-show ul li, .animepost').each((_, el) => {
            const titleNode = $(el).find('.title, .entry-title, .tt h2').first();
            const epNode = $(el).find('author[itemprop="name"], .epx').first();
            if (titleNode.length && epNode.length) {
                const judul = titleNode.text().trim();
                const epsText = epNode.text().trim();
                const status = epsText.toLowerCase().includes('eps') ? epsText : `Eps ${epsText}`;
                updates.push({ judul, status });
            }
        });
    } catch (e) {
        console.error(`[Samehadaku Scraper] Gagal memuat updates:`, e.message);
    } finally {
        if (slot) releaseToPool(slot);
    }
    return updates;
}

export { cache };
