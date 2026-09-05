import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { OtakudesuInstance } from 'otakudesu-scraper';
import Anime from '../../models/Anime.js';
import { getCache } from '../../utils/cacheManager.js';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
import { releaseToPool } from '../../puppeteer/pool.js';
import { formatEpisodeTitle, extractEpNumStrict, cleanSeriesTitle } from '../../utils/stringUtils.js';
import { assertAndRespondContract } from '../../utils/contractValidator.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';
import { extractEpNum, extractOtakuSlug } from '../../utils/stringUtils.js';

const cache = getCache('episodes_otakudesu', 3600);

export const scraperMeta = {
    id: 'otakudesu',
    name: 'Otakudesu',
    domains: ['otakudesu'] // support URL & lokal slug API diurus oleh ProviderRegistry
};

export async function scrapeEpisodes(url) {
    const slug = extractOtakuSlug(url);
    const data = await getOtakuEpisodesFormatted(slug);
    if (!data) throw new Error("Anime tidak ditemukan di Otakudesu");
    return data;
}

const resolveLimit = pLimit(3); // Maksimal 3 request serentak untuk mencegah Self-DDoS
const badHosts = new Map(); // Simpan host yang sedang cooldown
const hostFailCounts = new Map();

const otaku = new OtakudesuInstance(PROVIDER_URLS.OTAKUDESU.BASE_URL);


export async function getEpisodes(req, res) {
    try {
        const slug = req.params.slug;
        const data = await getOtakuEpisodesFormatted(slug);
        if (!data) return res.status(404).json({ error: "Anime tidak ditemukan di Otakudesu" });
        if (!assertAndRespondContract(res, data, 'episodes', 'Otakudesu')) return;
        res.json(data);
    } catch (err) {
        console.error("[Otakudesu Episodes Error]", err.message);
        res.status(500).json({ error: err.message });
    }
}

export async function getOtakuEpisodesFormatted(slug) {
    const cacheKey = `otaku_eps_${slug}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData && cachedData.daftar_episode && cachedData.daftar_episode.length > 0) {
        console.log(`[Otakudesu Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    console.log(`[Otakudesu] Fetching episodes for: ${slug}`);
    const details = await otaku.getExtraAnime(slug);

    if (!details) return null;

    // Fallback title dari database MongoDB jika parser scraper gagal mendapatkan nama
    const found = await Anime.findOne({ sourceUrls: { $regex: slug, $options: 'i' } }).lean();
    let fallbackTitle = found ? found.title : slug;
    let finalTitle = details.title ? details.title.replace(/^Nonton\s+/i, '').trim() : fallbackTitle;

    // Bersihkan lagi jika masih ada awalan "Nonton Anime " atau "Nonton " yang tersisa
    finalTitle = finalTitle.replace(/^Nonton\s+(Anime\s+)?/i, '').trim();
    if (!finalTitle || finalTitle === '') {
        finalTitle = fallbackTitle;
    }

    // Terakhir, jika entah bagaimana masih berformat slug, percantik secara otomatis:
    if (finalTitle === slug) {
        finalTitle = finalTitle.split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    // Filter episodes: reject cross-season sidebar navigation links that Otakudesu library
    // mistakenly includes in the episode list.
    // Guard 1: anime detail URLs (/anime/...) are series pages, not episode pages.
    // Guard 2: titles still containing "Subtitle Indonesia" / "Sub Indo" are series-nav labels.
    // Guard 3: titles with no episode-number marker and containing "Season" are series-nav labels.
    const EPISODE_MARKER_RE = /\b(?:episode|ep|eps|ova|oad|special|sp|movie|film|\d)\b/i;
    const SERIES_NAV_RE = /(?:subtitle\s*indonesia|sub\s*indo)/i;

    const rawEpisodes = (details.episodes || []);
    const cleanedEpisodes = rawEpisodes.reduce((acc, ep) => {
        // Guard 1: reject anime detail URLs
        let urlPath;
        try { urlPath = new URL(ep.url).pathname; } catch { urlPath = ep.url; }
        if (urlPath.includes('/anime/')) {
            console.warn(`[Otakudesu] ⚠️ Menolak URL seri (bukan episode): ${ep.url}`);
            return acc;
        }

        const formattedTitle = formatEpisodeTitle(ep.title);

        // Guard 2: reject titles that still contain SEO series-nav keywords
        if (SERIES_NAV_RE.test(formattedTitle)) {
            console.warn(`[Otakudesu] ⚠️ Menolak judul navigasi seri ("${formattedTitle}") dari: ${ep.url}`);
            return acc;
        }

        // Guard 3: reject titles that have no episode marker and contain "Season" — these are cross-season sidebar links
        if (!EPISODE_MARKER_RE.test(formattedTitle) && /\bseason\b/i.test(formattedTitle)) {
            console.warn(`[Otakudesu] ⚠️ Menolak judul seri lintas-musim ("${formattedTitle}") dari: ${ep.url}`);
            return acc;
        }

        const epParts = ep.url.split('/').filter(Boolean);
        const epSlug = epParts[epParts.length - 1];
        acc.push({
            judul: formattedTitle,
            url: ep.url,
            slug: epSlug
        });
        return acc;
    }, []);

    const result = {
        judul_seri: cleanSeriesTitle(finalTitle),
        cover_scraper: details.thumb || '',
        daftar_episode: cleanedEpisodes
    };

    if (result.daftar_episode && result.daftar_episode.length > 0) {
        cache.set(cacheKey, result);
    } else {
        console.warn(`[Otakudesu] Peringatan: 0 episode ditemukan untuk ${cacheKey}. Hasil tidak disimpan ke cache.`);
    }
    return result;
}

export async function getServers(req, res) {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: "Parameter url wajib diisi" });

        const data = await getServersInternal(url);
        if (!assertAndRespondContract(res, data, 'servers', 'Otakudesu')) return;
        res.json(data);
    } catch (err) {
        console.error("[Otakudesu Servers Error]", err.message);
        res.status(500).json({ error: err.message });
    }
}

async function resolveOtakuServers($) {
    const servers = [];
    const promises = [];
    const allowedHosts = ['kraken', 'pdrain', 'vidhide', 'filedon', 'gofile', 'acefile', 'mega', 'pucuk', 'pixeldrain', 'wibufile', 'filemoon', 'filelions', 'moonplayer', 'mirrorupload', 'desudrive', 'ondrive', 'mirror', 'zippyshare', 'filesim', 'hxfile', 'mp4upload', 'racaty', 'cloudmail', 'vstream', 'streamhide', 'yourupload', 'filecloud', 'desustream', 'berkasdrive', 'drive', 'google', 'anonfiles', 'bayfiles', 'letupload', 'uptobox', 'mediafire', 'streamhub', 'voe', 'streamsb', 'uqload', 'odrive', 'sendwire', 'mixdrop', 'dood', 'streamtape', 'abysscdn', 'kurodrive', 'solidfiles', 'tusfiles', 'usercloud', 'userscloud', 'ulozto', 'clicknupload', 'hexupload', 'rapidgator', 'turbobit', 'nitroflare', 'filerio', 'dailyuploads', 'downace', 'filescdn', 'indishare', 'bdupload', 'uptostream', 'streamango', 'openload', 'verystream', 'clipwatching', 'vidoza', 'vidia', 'filechan', 'letsupload', 'yandex', 'mail.ru', 'dropapk', 'megaup', 'otakudesu', 'samehadaku', 'kuronime', 'nanime', 'embed', 'player', 'video', 'stream'];

    $('.download ul li, .batchlink ul li, .siap ul li').each((i, el) => {
        const resText = $(el).find('strong').text().trim(); // e.g. "Mp4 360p"
        $(el).find('a').each((j, a) => {
            const hostRaw = $(a).text().trim();
            const hostLower = hostRaw.toLowerCase();
            const href = $(a).attr('href');

            if (allowedHosts.some(h => hostLower.includes(h))) {
                if (badHosts.has(hostLower) && Date.now() < badHosts.get(hostLower)) {
                    console.log(`[CircuitBreaker] Melewati ${hostRaw}, sedang dalam masa cooldown.`);
                    return;
                }

                promises.push(resolveLimit(async () => {
                    if (badHosts.has(hostLower) && Date.now() < badHosts.get(hostLower)) {
                        return;
                    }
                    try {
                        const redRes = await axios.request({
                            method: 'HEAD',
                            url: href,
                            maxRedirects: 0,
                            validateStatus: () => true,
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                            timeout: 3500
                        }).catch(() => axios.get(href, {
                            maxRedirects: 0,
                            validateStatus: () => true,
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                            timeout: 3500
                        }));

                        let directUrl = redRes.headers.location;
                        // Fallback: jika bukan redirect (status 200), gunakan URL aslinya
                        if (!directUrl && redRes.status >= 200 && redRes.status < 300) {
                            directUrl = href;
                        }
                        if (directUrl) {
                            hostFailCounts.delete(hostLower);
                            let kualitas = 'SD';
                            const lowerRes = resText.toLowerCase();
                            if (lowerRes.includes('1080')) kualitas = '1080p';
                            else if (lowerRes.includes('720')) kualitas = '720p';
                            else if (lowerRes.includes('480')) kualitas = '480p';
                            else if (lowerRes.includes('360')) kualitas = '360p';

                            servers.push({
                                nama: resText,
                                kualitas: kualitas,
                                namaHost: hostRaw,
                                iframeUrl: directUrl,
                                type: 'direct',
                                aktif: false
                            });
                        }
                    } catch (e) {
                        const failCount = (hostFailCounts.get(hostLower) || 0) + 1;
                        hostFailCounts.set(hostLower, failCount);
                        if (failCount >= 3) {
                            badHosts.set(hostLower, Date.now() + 5 * 60 * 1000); // 5 menit cooldown
                            console.warn(`[CircuitBreaker] Host ${hostRaw} gagal ${failCount}x berturut-turut. Membuka circuit selama 5 menit.`);
                        }
                        console.log(`[Otakudesu] Resolve failed for ${hostRaw}: ${e.message}`);
                    }
                }));
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
    if (!url) return { judul: '', servers: [], nav_prev: null, nav_next: null };
    if (url.startsWith('/api/otakudesu/servers') || url.includes('/api/otakudesu/servers?url=')) {
        try {
            const parsed = new URL(url.startsWith('http') ? url : 'http://localhost' + url);
            url = parsed.searchParams.get('url') || url;
        } catch (e) {}
    }

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
            judul = cleanSeriesTitle(judul);
        }

        // Parsing Prev / Next Navigation dari elemen HTML (Otakudesu class: flir)
        let nav_prev = null;
        let nav_next = null;
        $('.flir a').each((i, el) => {
            const text = $(el).text().trim().toLowerCase();
            const href = $(el).attr('href');

            if (!href || href === '#') return;

            if (text.includes('prev') || text.includes('sebelumnya')) {
                nav_prev = href;
            } else if (text.includes('next') || text.includes('selanjutnya')) {
                nav_next = href;
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

export async function getOtakudesuLatestUpdates() {
    const { PROVIDER_URLS } = await import('../../config/providerUrls.js');
    const url = `${PROVIDER_URLS.OTAKUDESU.BASE_URL}/`;
    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) return [];
        const $ = fetchRes.$;
        $('.venz ul li').each((_, el) => {
            const title = $(el).find('.jdlflm').text().trim();
            const ep = $(el).find('.epz').text().trim();
            if (title && ep) {
                updates.push({ title, status: ep });
            }
        });
    } catch (e) {
        console.error(`[Otakudesu Scraper] Gagal memuat updates:`, e.message);
    } finally {
        if (slot) releaseToPool(slot);
    }
    return updates;
}


// --- DYNAMIC PLUGIN SYSTEM ALIASES ---
export const scrapeServers = getServersInternal;
export const scrapeLatestUpdates = getOtakudesuLatestUpdates;
