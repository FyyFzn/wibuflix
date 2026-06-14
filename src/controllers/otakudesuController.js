import axios from 'axios';
import * as cheerio from 'cheerio';
import { OtakudesuInstance } from 'otakudesu-scraper';
import Anime from '../models/Anime.js';
import { enrichWithMAL } from '../utils/malEnrichment.js';

const otaku = new OtakudesuInstance('https://otakudesu.blog');

export async function getEpisodes(req, res) {
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

export async function getOtakuEpisodesFormatted(slug) {
    console.log(`[Otakudesu] Fetching episodes for: ${slug}`);
    const details = await otaku.getExtraAnime(slug);

    if (!details) return null;

    // Fallback title dari database MongoDB jika parser scraper gagal mendapatkan nama
    const found = await Anime.findOne({ "sources.otakudesu.url": new RegExp(slug, 'i') }).lean();
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
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    // Fungsi untuk merapikan judul episode Otakudesu (menghilangkan tanggal dan judul seri)
    const cleanEpisodeTitle = (title) => {
        if (!title) return "Episode ?";
        if (title.toLowerCase().includes('batch')) return "Batch";
        
        const ovaMatch = title.match(/(OVA|Special|SP)\s*(\d+(\.\d+)?)/i);
        if (ovaMatch) return `${ovaMatch[1].toUpperCase()} ${ovaMatch[2]}`;
        
        const stdMatch = title.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i);
        if (stdMatch) return `Episode ${stdMatch[1]}`;
        
        const fallbackMatch = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
        if (fallbackMatch) return `Episode ${fallbackMatch[1]}`;
        
        return title;
    };

    const result = {
        judul_seri: finalTitle,
        cover_scraper: details.thumb || '',
        daftar_episode: details.episodes.map(ep => {
            const epParts = ep.url.split('/').filter(Boolean);
            const epSlug = epParts[epParts.length - 1];
            return {
                judul: cleanEpisodeTitle(ep.title),
                url: `/api/otakudesu/servers?url=${encodeURIComponent(ep.url)}`,
                slug: epSlug
            };
        })
    };

    // ── MAL Enrichment ──
    const { mal, enrichedEpisodes } = await enrichWithMAL(finalTitle, result.daftar_episode, details.thumb);

    result.daftar_episode = enrichedEpisodes;
    result.mal = mal;

    return result;
}

export async function getServers(req, res) {
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

async function resolveOtakuServers($) {
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
                    } catch (e) {
                        console.log(`[Otakudesu] Resolve failed for ${hostRaw}: ${e.message}`);
                    }
                })());
            }
        });
    });

    await Promise.all(promises);

    // Deduplikasi server
    const uniqueServers = [];
    const seenServers = new Set();
    for (const s of servers) {
        const safeNama = s.nama ? s.nama.trim().toLowerCase().replace(/\s+/g, ' ') : '';
        const safeHost = s.namaHost ? s.namaHost.trim().toLowerCase() : '';
        const key = `${safeNama}-${safeHost}`;
        if (!seenServers.has(key)) {
            seenServers.add(key);
            uniqueServers.push(s);
        }
    }

    if (uniqueServers.length > 0) {
        uniqueServers[0].aktif = true;
    }
    return uniqueServers;
}

export async function getServersInternal(url) {
    console.log(`[Otakudesu] Fetching servers from: ${url}`);

    // Fetch raw HTML of the episode
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000
    });

    const $ = cheerio.load(data);
    const uniqueServers = await resolveOtakuServers($);

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
        servers: uniqueServers,
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

export async function getAlternativeServers(seriesTitle, episodeTitle, seriesUrl = null) {
    if (!seriesTitle || !episodeTitle) return [];

    try {
        const dbItems = await Anime.find({ "sources.otakudesu.url": { $ne: null } }).lean();
        const otakuDb = dbItems.map(item => {
            const urlParts = item.sources.otakudesu.url.split('/').filter(Boolean);
            const slugStr = urlParts[urlParts.length - 1];
            return { title: item.title, slug: slugStr };
        });
        if (!otakuDb || otakuDb.length === 0) return [];

        const query = seriesTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const queryWords = query.split(' ').filter(w => w.length > 2);

        let bestMatch = null;
        let maxMatches = 0;

        for (const item of otakuDb) {
            const itemTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
            let matches = 0;
            for (const w of queryWords) {
                if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(itemTitle)) matches++;
            }
            if (matches > maxMatches) {
                maxMatches = matches;
                bestMatch = item;
            }
        }

        if (!bestMatch || maxMatches < queryWords.length / 2) return [];

        const targetEpNumRaw = extractEpisodeNumber(episodeTitle);
        if (targetEpNumRaw === null) return [];

        const details = await otaku.getExtraAnime(bestMatch.slug);
        if (!details || !details.episodes) return [];

        let offsetOtaku = 0;
        if (seriesUrl) {
            try {
                // To avoid circular dependency with episodes.js, we assume the caller passes the offset, 
                // but since we don't have it, we'll try to import dynamically and fetch
                const episodesModule = await import('./episodes.js');
                const sameRes = await episodesModule.getEpisodes(seriesUrl);
                
                if (sameRes && sameRes.daftar_episode) {
                    const sameEps = sameRes.daftar_episode.map(ep => extractEpisodeNumber(ep.judul)).filter(n => n !== null);
                    const otakuEps = details.episodes.map(ep => extractEpisodeNumber(ep.title)).filter(n => n !== null);
                    
                    if (sameEps.length > 0 && otakuEps.length > 0) {
                        const minSame = Math.min(...sameEps);
                        const minOtaku = Math.min(...otakuEps);
                        const sameSet = new Set(sameEps);
                        if (!otakuEps.some(num => sameSet.has(num))) {
                            if (minOtaku === 1 && minSame > 1) {
                                offsetOtaku = minSame - 1;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("[Otakudesu Alternative Offset Error]", e.message);
            }
        }

        const targetEpNum = targetEpNumRaw - offsetOtaku;

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
        const servers = await resolveOtakuServers($);
        return servers;
    } catch (e) {
        console.error("[Otakudesu Alternative Error]", e.message);
        return [];
    }
}
