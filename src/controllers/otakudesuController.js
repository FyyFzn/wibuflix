import axios from 'axios';
import * as cheerio from 'cheerio';
import { OtakudesuInstance } from 'otakudesu-scraper';
import Anime from '../models/Anime.js';
import { getCache } from '../utils/cacheManager.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import { formatEpisodeTitle, extractEpNumStrict } from '../utils/stringUtils.js';

const cache = getCache('otakudesu', 3600);


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
    const cacheKey = `otaku_eps_${slug}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Otakudesu Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`[Otakudesu] Fetching episodes for: ${slug}`);
    const details = await otaku.getExtraAnime(slug);

    if (!details) return null;

    // Fallback title dari database MongoDB jika parser scraper gagal mendapatkan nama
    const found = await Anime.findOne({ "sources.otakudesu.id": slug }).lean();
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

    const result = {
        judul_seri: finalTitle,
        cover_scraper: details.thumb || '',
        daftar_episode: details.episodes.map(ep => {
            const epParts = ep.url.split('/').filter(Boolean);
            const epSlug = epParts[epParts.length - 1];
            return {
                judul: formatEpisodeTitle(ep.title),
                url: `/api/otakudesu/servers?url=${encodeURIComponent(ep.url)}`,
                slug: epSlug
            };
        })
    };

    cache.set(cacheKey, result);
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
                            timeout: 3500
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
    const cacheKey = `otaku_servers_${url}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    console.log(`[Otakudesu] Fetching servers from: ${url}`);

    let slot = null;
    let $;
    try {
        const fetchRes = await fetchWithCF(url, { fetchTimeout: 10000 });
        slot = fetchRes.slot;
        $ = fetchRes.$;
        
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

        const result = {
            judul,
            servers: uniqueServers,
            nav_prev,
            nav_next
        };

        if (uniqueServers.length > 0) {
            cache.set(cacheKey, result);
        }

        return result;
    } finally {
        if (slot) releaseToPool(slot);
    }
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

        const targetEpNumRaw = extractEpNumStrict(episodeTitle);
        if (targetEpNumRaw === null) return [];

        const details = await otaku.getExtraAnime(bestMatch.slug);
        if (!details || !details.episodes) return [];

        let offsetOtaku = 0;
        if (seriesUrl) {
            try {
                // To avoid circular dependency with episodeController.js, we assume the caller passes the offset, 
                // but since we don't have it, we'll try to import dynamically and fetch
                const episodesModule = await import('./samehadakuController.js');
                const sameRes = await episodesModule.getSamehadakuEpisodes(seriesUrl);
                
                if (sameRes && sameRes.daftar_episode) {
                    const sameEps = sameRes.daftar_episode.map(ep => extractEpNumStrict(ep.judul)).filter(n => n !== null);
                    const otakuEps = details.episodes.map(ep => extractEpNumStrict(ep.title)).filter(n => n !== null);
                    
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
            if (ep.title.toLowerCase().includes('batch')) continue;
            const epNum = extractEpNumStrict(ep.title);
            if (epNum === targetEpNum) {
                targetEpUrl = ep.url;
                break;
            }
        }

        if (!targetEpUrl) return [];

        let slot = null;
        let servers = [];
        try {
            const fetchRes = await fetchWithCF(targetEpUrl, { fetchTimeout: 10000 });
            slot = fetchRes.slot;
            servers = await resolveOtakuServers(fetchRes.$);
        } finally {
            if (slot) releaseToPool(slot);
        }
        
        return servers;
    } catch (e) {
        console.error("[Otakudesu Alternative Error]", e.message);
        return [];
    }
}
