import { releaseToPool } from '../puppeteer/pool.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import * as cheerio from 'cheerio';
import { getCache } from '../utils/cacheManager.js';
import Anime from '../models/Anime.js';
import { extractEpNumStrict } from '../utils/stringUtils.js';
import { scrapeVideoServers } from '../services/extractors/videoExtractor.js';

const cache = getCache('episodes', 3600);

export async function getSamehadakuEpisodes(targetUrl) {
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

export async function getAlternativeServers(seriesTitle, episodeTitle) {
    if (!seriesTitle || !episodeTitle) return [];

    try {
        let samehadakuUrl = null;

        // 1. Try unified database first for mapping
        let matchedEntry = await Anime.findOne({
            $or: [
                { title: { $regex: new RegExp(`^${seriesTitle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i') } },
                { aliases: { $regex: new RegExp(`^${seriesTitle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i') } }
            ]
        });

        // Fuzzy match in unified_db if exact match not found
        if (!matchedEntry) {
            const queryWords = seriesTitle.replace(/[^a-zA-Z0-9]+/g, ' ').split(' ').filter(w => w.length > 2);
            if (queryWords.length > 0) {
                // Cari data yang mengandung setidaknya salah satu kata kunci
                const regexes = queryWords.map(w => new RegExp(`\\b${w}\\b`, 'i'));
                matchedEntry = await Anime.findOne({
                    $or: [
                        { title: { $in: regexes } },
                        { aliases: { $in: regexes } }
                    ]
                });
            }
        }

        if (matchedEntry && matchedEntry.sources && matchedEntry.sources.samehadaku) {
            samehadakuUrl = matchedEntry.sources.samehadaku.url;
        }

        if (!samehadakuUrl) {
            console.log(`[Samehadaku Alt] Tidak menemukan kecocokan seri untuk: "${seriesTitle}"`);
            return [];
        }

        console.log(`[Samehadaku Alt] Menemukan kecocokan seri Samehadaku: "${samehadakuUrl}"`);

        const targetEpNum = extractEpNumStrict(episodeTitle);
        if (targetEpNum === null) return [];

        const details = await getSamehadakuEpisodes(samehadakuUrl);
        if (!details || !details.daftar_episode) return [];

        let targetEpUrl = null;
        for (const ep of details.daftar_episode) {
            if (ep.judul.toLowerCase().includes('batch')) continue;
            const epNum = extractEpNumStrict(ep.judul);
            if (epNum === targetEpNum) {
                targetEpUrl = ep.url;
                break;
            }
        }

        if (!targetEpUrl) {
            console.log(`[Samehadaku Alt] Tidak menemukan episode ${targetEpNum} di Samehadaku`);
            return [];
        }

        console.log(`[Samehadaku Alt] Menemukan episode URL alternatif: "${targetEpUrl}"`);
        const scrapeResult = await scrapeVideoServers(targetEpUrl);
        return scrapeResult.servers || [];
    } catch (e) {
        console.error("[Samehadaku Alternative Error]", e.message);
        return [];
    }
}


export { cache };
