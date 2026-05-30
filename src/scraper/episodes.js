const { ambilDariPool, kembalikanKePool } = require('../puppeteer/pool');
const { searchAnime, getAnimeEpisodes } = require('../api/jikan');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1 jam (super cepat)

async function getEpisodes(targetUrl) {
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
        slot = await ambilDariPool();
        const page = slot.page;

        const html = await page.evaluate(async (url) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                return await res.text();
            } catch(e) {
                return '';
            }
        }, targetUrl);

        if (!html) throw new Error("Gagal mengambil HTML dari target");

        const $ = cheerio.load(html);
        
        const rawTitle = ($('title').text() || '').replace(/[-–|].*$/, '').trim();
        const daftar_episode = [];

        const coverImg = 
            $('meta[property="og:image"]').attr('content') ||
            $('.thumb img, .thumbook img').attr('src') || '';

        $('.lstepsiode ul li, .episodelist ul li').each((_, el) => {
            const epLink = $(el).find('.epsleft a, a').first();
            const epDate = $(el).find('.epsright, .date').first();
            if (epLink.length && epLink.attr('href')) {
                daftar_episode.push({
                    judul: epLink.text().trim(),
                    url: epLink.attr('href'),
                    tanggal: epDate.length ? epDate.text().trim() : '',
                });
            }
        });

        const result = { judul_seri: rawTitle, cover_scraper: coverImg, daftar_episode };

        // ── MAL: ambil info anime + judul episode secara paralel ──
        let mal = null;
        let malEpisodeMap = {};

        try {
            console.log(`[MAL] Mencari data untuk: "${result.judul_seri}"`);
            mal = await searchAnime(result.judul_seri);

            if (mal) {
                console.log(`[MAL] Ketemu: score=${mal.malScore}, genres=${mal.genres.join(', ')}`);
                // Ambil judul episode dari MAL
                malEpisodeMap = await getAnimeEpisodes(mal.malId, mal.episodes);
            } else {
                console.log(`[MAL] Tidak ditemukan untuk: "${result.judul_seri}"`);
            }
        } catch (e) {
            console.warn(`[MAL] Error:`, e.message);
        }

        // ── Inject judul MAL ke tiap episode ──
        if (Object.keys(malEpisodeMap).length > 0) {
            result.daftar_episode.forEach(ep => {
                const match = ep.judul.match(/episode\s+(\d+)/i) || ep.judul.match(/(\d+)$/);
                if (match) {
                    const num = String(parseInt(match[1], 10));
                    const malTitle = malEpisodeMap[num];
                    if (malTitle) ep.malJudul = malTitle;
                }
            });
        }

        const enriched = {
            ...result,
            mal: mal ? {
                malId:    mal.malId,
                malUrl:   mal.malUrl,
                malScore: mal.malScore,
                malRank:  mal.malRank,
                genres:   mal.genres,
                synopsis: mal.synopsis,
                episodes: mal.episodes,
                status:   mal.status,
                studios:  mal.studios,
                year:     mal.year,
                rating:   mal.rating,
                cover:    mal.cover || result.cover_scraper,
                coverWebp:mal.coverWebp || null,
            } : null,
        };

        cache.set(cacheKey, enriched);
        return enriched;
    } catch (err) {
        throw err;
    } finally {
        if (slot) kembalikanKePool(slot);
    }
}

module.exports = { getEpisodes, cache };
