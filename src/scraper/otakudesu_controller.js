const axios = require('axios');
const cheerio = require('cheerio');
const { OtakudesuInstance } = require('otakudesu-scraper');

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

    return {
        judul: details.name,
        judul_seri: details.name, // Kompatibilitas frontend
        gambar: details.image || '',
        cover_scraper: details.image || '', // Kompatibilitas frontend
        sinopsis: details.synopsis || '',
        genre: Array.isArray(details.details.genre) ? details.details.genre.join(', ') : (details.details.genre || ''),
        rating: details.details.skor || '-',
        tipe: details.details.tipe || '-',
        status: details.details.status || 'Completed',
        total_episode: details.details.total_episode || '?',
        daftar_episode: details.episodes.map(ep => { // Kompatibilitas frontend
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
        episodes: details.episodes.map(ep => { // Original untuk kompatibilitas Web Lama
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
                        
                        const directUrl = redRes.headers.location;
                        if (directUrl) {
                            servers.push({
                                nama: resText,
                                namaHost: hostRaw,
                                iframeUrl: directUrl, // URL yang sudah diresolve, akan dikirim ke client
                                type: 'direct',
                                aktif: servers.length === 0
                            });
                        }
                    } catch(e) {
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

    const judul = $('.venutama h1.posttl').text().trim();
    
    return {
        judul,
        servers,
        nav_prev: null, // belum implementasi nav prev/next
        nav_next: null
    };
}

function extractEpisodeNumber(title) {
    if (!title) return null;
    const match = title.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i);
    return match ? parseFloat(match[1]) : null;
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
                if (w.length > 2 && itemTitle.includes(w)) matches++;
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
                            const directUrl = redRes.headers.location;
                            if (directUrl) {
                                servers.push({
                                    nama: resText,
                                    namaHost: hostRaw,
                                    iframeUrl: directUrl,
                                    type: 'direct',
                                    aktif: false
                                });
                            }
                        } catch(e) {}
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
