const axios = require('axios');
const cheerio = require('cheerio');
const { OtakudesuInstance } = require('otakudesu-scraper');
const { searchAnime, getAnimeEpisodes } = require('../api/jikan');

const otaku = new OtakudesuInstance('https://otakudesu.blog');

async function getEpisodes(req, res) {
    try {
        const slug = req.params.slug;
        const data = await getOtakuEpisodesFormatted(slug);
        if (!data) return res.status(404).json({ error: "Anime tidak ditemukan di Otakudesu" });
        res.json(data);
    } catch (err) {
        console.error("[Otakudesu Episodes Error]", err.message);
        res.status(500).json({ error: err.message });
    }
}

async function getOtakuEpisodesFormatted(slug) {
    console.log(`[Otakudesu] Fetching episodes for: ${slug}`);
    const details = await otaku.getExtraAnime(slug);

    if (!details) return null;

    // Fallback title dari database lokal jika parser scraper gagal mendapatkan nama
    const { loadOtakuDatabase } = require('./otakudesu_sync');
    const otakuDb = loadOtakuDatabase();
    const found = otakuDb.find(item => item.slug === slug || item.id === `otakudesu:${slug}`);
    let fallbackTitle = found ? found.title : slug;
    
    // Bersihkan teks status dari judul database (misal: "Anime Title On-Going")
    fallbackTitle = fallbackTitle.replace(/\s*on-going\s*$/i, '').replace(/\s*completed\s*$/i, '').replace(/\"/g, '').trim();
    
    let finalTitle = details.name;

    // Jika library mengembalikan slug, paksa gunakan fallbackTitle
    if (!finalTitle || finalTitle.toLowerCase() === slug.toLowerCase() || finalTitle.includes('-sub-indo')) {
        finalTitle = fallbackTitle;
    }

    // Terakhir, jika entah bagaimana masih berformat slug, percantik secara otomatis:
    if (finalTitle === slug) {
        finalTitle = finalTitle.split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ')
            .replace(/Sub Indo/i, '')
            .trim();
    }

    const result = {
        judul: finalTitle,
        judul_seri: finalTitle, // Kompatibilitas frontend
        gambar: details.image || '',
        cover_scraper: details.image || '', // Kompatibilitas frontend
        sinopsis: details.synopsis || '',
        genre: Array.isArray(details.details?.genre) ? details.details.genre.join(', ') : (details.details?.genre || ''),
        rating: details.details?.skor || '-',
        tipe: details.details?.tipe || '-',
        status: details.details?.status || 'Completed',
        total_episode: details.details?.total_episode || '?',
        daftar_episode: (details.episodes || []).map(ep => { // Kompatibilitas frontend
            const epParts = ep.url.split('/').filter(Boolean);
            const epSlug = epParts[epParts.length - 1];

            // Smart Extraction untuk Judul Episode
            let cleanTitle = ep.title;
            const match = ep.title.match(/(?:Episode|Eps|Ep|OVA|Special|SP)\s*\d+(\.\d+)?(\s*-\s*\d+(\.\d+)?)?\s*(\(End\))?/i);

            if (match) {
                cleanTitle = match[0];
            } else {
                // Fallback pembersih string jika regex tidak cocok
                if (details.name) cleanTitle = cleanTitle.replace(details.name, '').trim();
                cleanTitle = cleanTitle.replace(/subtitle indonesia/ig, '').trim();
                cleanTitle = cleanTitle.replace(/sub indo/ig, '').trim();
                cleanTitle = cleanTitle.replace(/^[:-]/, '').trim();
                if (!cleanTitle) cleanTitle = ep.title;
            }

            return {
                judul: cleanTitle,
                url: `/api/otakudesu/servers?url=${encodeURIComponent(ep.url)}`,
                tanggal: ep.date || '',
                slug: epSlug
            };
        }),
        episodes: (details.episodes || []).map(ep => { // Original untuk kompatibilitas Web Lama
            const epParts = ep.url.split('/').filter(Boolean);
            const epSlug = epParts[epParts.length - 1];
            return {
                title: ep.title,
                url: `/api/otakudesu/servers?url=${encodeURIComponent(ep.url)}`,
                date: ep.date || '',
                slug: epSlug
            };
        })
    };

    // ── MAL Enrichment (Jikan API) ──
    let mal = null;
    let malEpisodeMap = {};

    try {
        console.log(`[Otakudesu-MAL] Mencari data untuk: "${finalTitle}"`);
        mal = await searchAnime(finalTitle);

        if (mal) {
            console.log(`[Otakudesu-MAL] Ketemu: score=${mal.malScore}, genres=${mal.genres.join(', ')}`);
            malEpisodeMap = await getAnimeEpisodes(mal.malId, mal.episodes);
        } else {
            console.log(`[Otakudesu-MAL] Tidak ditemukan untuk: "${finalTitle}"`);
        }
    } catch (e) {
        console.warn(`[Otakudesu-MAL] Error:`, e.message);
    }

    // Inject judul MAL ke tiap episode
    if (Object.keys(malEpisodeMap).length > 0) {
        result.daftar_episode.forEach(ep => {
            const match = ep.judul.match(/(?:episode|eps|ep)\s*(\d+)/i) || ep.judul.match(/(\d+)$/);
            if (match) {
                const num = String(parseInt(match[1], 10));
                const malTitle = malEpisodeMap[num];
                if (malTitle) ep.malJudul = malTitle;
            }
        });
    }

    // Tambahkan MAL object ke response
    result.mal = mal ? {
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
        coverWebp: mal.coverWebp || null,
    } : null;

    return result;
}

async function getServers(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: "Parameter url wajib diisi" });

        const data = await getServersInternal(url);
        res.json(data);
    } catch (err) {
        console.error("[Otakudesu Servers Error]", err.message);
        res.status(500).json({ error: err.message });
    }
}

async function getServersInternal(url) {
    console.log(`[Otakudesu] Fetching servers from: ${url}`);

    // Fetch raw HTML of the episode
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000
    });

    const $ = cheerio.load(data);
    const servers = [];

    const promises = [];
    const allowedHosts = ['kraken', 'pdrain', 'vidhide', 'filedon', 'gofile', 'acefile', 'mega'];

    $('.download ul li').each((i, el) => {
        const resText = $(el).find('strong').text().trim(); // e.g. "Mp4 360p"
        $(el).find('a').each((j, a) => {
            const hostRaw = $(a).text().trim();
            const hostLower = hostRaw.toLowerCase();
            const href = $(a).attr('href');

            if (allowedHosts.some(h => hostLower.includes(h))) {
                promises.push((async () => {
                    try {
                        // Resolve the desustream.com redirect link
                        // e.g. https://link.desustream.com/?id=...
                        const redRes = await axios.get(href, {
                            maxRedirects: 0,
                            validateStatus: () => true,
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                            timeout: 8000
                        });

                        let directUrl = redRes.headers.location;
                        // Fallback: jika bukan redirect (status 200), gunakan URL aslinya
                        if (!directUrl && redRes.status >= 200 && redRes.status < 300) {
                            directUrl = href;
                        }
                        if (directUrl) {
                            servers.push({
                                nama: resText,
                                namaHost: hostRaw,
                                iframeUrl: directUrl, // URL yang sudah diresolve, akan dikirim ke client
                                type: 'direct',
                                aktif: false
                            });
                        }
                    } catch (e) {
                        console.log(`[Otakudesu] Resolve failed for ${hostRaw}: ${e.message}`);
                    }
                })());
            }
        });
    });

    // Tunggu semua resolve selesai
    await Promise.all(promises);

    if (servers.length > 0) {
        servers[0].aktif = true;
    }

    // Ambil judul raw dari halaman episode dan bersihkan
    let judul = $('.venutama h1.posttl').text().trim();
    if (judul) {
        judul = judul.replace(/^Nonton\s+/i, '');
        judul = judul.replace(/\s*Subtitle Indonesia$/i, '');
        judul = judul.replace(/\s*Sub Indo$/i, '');
        judul = judul.trim();
    }

    // Parsing Prev / Next Navigation dari elemen HTML (Otakudesu class: flir)
    let nav_prev = null;
    let nav_next = null;
    $('.flir a').each((i, el) => {
        const text = $(el).text().trim().toLowerCase();
        const href = $(el).attr('href');
        
        if (!href || href === '#') return;

        if (text.includes('prev') || text.includes('sebelumnya')) {
            nav_prev = `/api/otakudesu/servers?url=${encodeURIComponent(href)}`;
        } else if (text.includes('next') || text.includes('selanjutnya')) {
            nav_next = `/api/otakudesu/servers?url=${encodeURIComponent(href)}`;
        }
    });

    return {
        judul,
        servers,
        nav_prev,
        nav_next
    };
}

function extractEpisodeNumber(title) {
    if (!title) return null;
    // Prioritas 1: Format standar (Episode/Eps/Ep diikuti angka)
    const stdMatch = title.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i);
    if (stdMatch) return parseFloat(stdMatch[1]);

    // Prioritas 2: Format OVA/Special (OVA 1, Special 3, dll.)
    const ovaMatch = title.match(/(?:OVA|Special|SP)\s*(\d+(\.\d+)?)/i);
    if (ovaMatch) return parseFloat(ovaMatch[1]);

    // Prioritas 3: Angka terakhir yang berdiri sendiri dalam judul (fallback)
    const fallbackMatch = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallbackMatch) return parseFloat(fallbackMatch[1]);

    return null;
}

async function getAlternativeServers(seriesTitle, episodeTitle) {
    if (!seriesTitle || !episodeTitle) return [];

    try {
        const { loadOtakuDatabase } = require('./otakudesu_sync');
        const otakuDb = loadOtakuDatabase();
        if (!otakuDb || otakuDb.length === 0) return [];

        const query = seriesTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const queryWords = query.split(' ');

        let bestMatch = null;
        let maxMatches = 0;

        for (const item of otakuDb) {
            const itemTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
            let matches = 0;
            for (const w of queryWords) {
                if (w.length > 2 && new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(itemTitle)) matches++;
            }
            if (matches > maxMatches) {
                maxMatches = matches;
                bestMatch = item;
            }
        }

        if (!bestMatch || maxMatches < queryWords.length / 2) return [];

        const targetEpNum = extractEpisodeNumber(episodeTitle);
        if (targetEpNum === null) return [];

        const details = await otaku.getExtraAnime(bestMatch.slug);
        if (!details || !details.episodes) return [];

        let targetEpUrl = null;
        for (const ep of details.episodes) {
            const epNum = extractEpisodeNumber(ep.title);
            if (epNum === targetEpNum) {
                targetEpUrl = ep.url;
                break;
            }
        }

        if (!targetEpUrl) return [];

        // Fetch raw HTML of the episode directly
        const { data } = await axios.get(targetEpUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });

        const $ = cheerio.load(data);
        const servers = [];
        const promises = [];
        const allowedHosts = ['kraken', 'pdrain', 'vidhide', 'filedon', 'gofile', 'acefile', 'mega'];

        $('.download ul li').each((i, el) => {
            const resText = $(el).find('strong').text().trim();
            $(el).find('a').each((j, a) => {
                const hostRaw = $(a).text().trim();
                const hostLower = hostRaw.toLowerCase();
                const href = $(a).attr('href');

                if (allowedHosts.some(h => hostLower.includes(h))) {
                    promises.push((async () => {
                        try {
                            const redRes = await axios.get(href, {
                                maxRedirects: 0,
                                validateStatus: () => true,
                                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                                timeout: 8000
                            });
                            let directUrl = redRes.headers.location;
                            // Fallback: jika bukan redirect (status 200), gunakan URL aslinya
                            if (!directUrl && redRes.status >= 200 && redRes.status < 300) {
                                directUrl = href;
                            }
                            if (directUrl) {
                                servers.push({
                                    nama: resText,
                                    namaHost: hostRaw,
                                    iframeUrl: directUrl,
                                    type: 'direct',
                                    aktif: false
                                });
                            }
                        } catch (e) { }
                    })());
                }
            });
        });

        await Promise.all(promises);
        return servers;
    } catch (e) {
        console.error("[Otakudesu Alternative Error]", e.message);
        return [];
    }
}

module.exports = {
    getEpisodes,
    getServers,
    getServersInternal,
    getAlternativeServers,
    getOtakuEpisodesFormatted
};
