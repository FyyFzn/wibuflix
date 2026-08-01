import Anime from '../models/Anime.js';
import { formatEpisodeTitle, extractEpNum, adjustTitleEpisodeNumber, extractOtakuSlug, cleanSeriesTitle } from '../utils/stringUtils.js';
import { PROVIDER_URLS, getProviderSeriesUrl } from '../config/providerUrls.js';
import { ProviderRegistry } from './ProviderRegistry.js';

const activeScrapeLocks = new Map();

/**
 * Mencegah episode ganda berdasarkan nomor atau judul episode dan me-merge URL dari berbagai provider.
 */
/**
 * Membersihkan kartu episode yang tercemar OVA / Special (Ova Contamination Sanitizer).
 * Memeriksa jika ada kartu episode normal (misal Episode 1) namun memiliki URL dari provider lain
 * yang mengarah ke OVA/Special, atau judul OVA yang keliru dilabeli sebagai nomor episode normal.
 */
export function sanitizeContaminatedEpisodeCards(episodesList) {
    if (!episodesList || !Array.isArray(episodesList)) return [];
    
    const ovaTitleRegex = /\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)[\s-_]*\d+/i;
    const ovaWordRegex = /\b(?:ova|oad|batch|nced|ncop|movie|film)\b/i;
    const ovaParenthesisRegex = /\((?:ova|oad|special|sp|ex|bonus|nced|ncop)\)|\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)\b\s*$/i;
    const ovaUrlRegex = /(?:-|\/)ova(?:-|\/|\b|_)|(?:-|\/)sp(?:-|\/|\b|_)|(?:-|\/)ex(?:-|\/|\b|_)|(?:-|\/)special(?:-|\/|\b|_)|(?:-|\/)bonus(?:-|\/|\b|_)/i;

    return episodesList.map(ep => {
        const epObj = ep && typeof ep === 'object' ? { ...ep } : {};
        if (epObj.urls && typeof epObj.urls === 'object') {
            epObj.urls = { ...epObj.urls };
        } else {
            epObj.urls = {};
        }

        const title = (epObj.judul || epObj.title || '').trim();
        const isOvaTitle = ovaTitleRegex.test(title) || ovaWordRegex.test(title) || ovaParenthesisRegex.test(title);

        // 1. Jika judul kartu itu sendiri adalah OVA / Special, pastikan num adalah null agar tidak keliru sebagai episode reguler
        if (isOvaTitle) {
            epObj.num = null;
        } else if (epObj.num != null && typeof epObj.num === 'number' && !isNaN(epObj.num)) {
            // 2. Jika kartu adalah episode reguler (misal num: 1), periksa seluruh URL provider di dalamnya.
            // Jika ada provider yang URL-nya secara jelas adalah OVA/Special, hapus URL tercemar tersebut dari kartu episode reguler ini!
            for (const [provKey, provUrl] of Object.entries(epObj.urls)) {
                if (typeof provUrl === 'string' && ovaUrlRegex.test(provUrl)) {
                    console.warn(`[Sanitizer] 🛡️ Menghapus URL tercemar OVA (${provKey}: ${provUrl}) dari kartu episode normal "${title}" (Ep ${epObj.num})`);
                    delete epObj.urls[provKey];
                }
            }
        }

        return epObj;
    });
}

export function deduplicateEpisodes(episodes) {
    if (!episodes || !Array.isArray(episodes) || episodes.length === 0) return [];
    
    // Step 1: Bersihkan kontaminasi awal sebelum penggabungan
    const sanitized = sanitizeContaminatedEpisodeCards(episodes);
    const dedupeMap = new Map();

    const ovaTitleRegex = /\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)[\s-_]*\d+/i;
    const ovaWordRegex = /\b(?:ova|oad|batch|nced|ncop|movie|film)\b/i;
    const ovaParenthesisRegex = /\((?:ova|oad|special|sp|ex|bonus|nced|ncop)\)|\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)\b\s*$/i;

    for (const ep of sanitized) {
        const titleLower = (ep.judul || '').toLowerCase().trim();
        const isOvaCandidate = ovaTitleRegex.test(titleLower) || ovaWordRegex.test(titleLower) || ovaParenthesisRegex.test(titleLower);
        const epNum = isOvaCandidate ? null : extractEpNum(ep.judul);
        const key = typeof epNum === 'number' && !isNaN(epNum) ? `ep_${epNum}` : titleLower;
        
        if (!dedupeMap.has(key)) {
            dedupeMap.set(key, { ...ep });
        } else {
            const existing = dedupeMap.get(key);
            const isExistingNormal = existing.num != null && !ovaTitleRegex.test(existing.judul || '') && !ovaWordRegex.test(existing.judul || '') && !ovaParenthesisRegex.test(existing.judul || '');

            if (isExistingNormal && isOvaCandidate) {
                // Jangan merge URL OVA/Special ke dalam kartu episode normal
                continue;
            }
            if (!isExistingNormal && epNum != null && !isOvaCandidate) {
                // Timpa kartu existing yang keliru/tercemar dengan kartu episode normal yang bersih
                dedupeMap.set(key, { ...ep });
                continue;
            }

            existing.urls = { ...existing.urls, ...ep.urls };
            if (existing.num == null && ep.num != null && !isOvaCandidate) {
                existing.num = ep.num;
            }
        }
    }
    return Array.from(dedupeMap.values());
}



/**
 * Cari anime di database lokal
 */
export async function findAnimeInDatabase({ targetUrl, providerUrls = {} }) {
    if (typeof targetUrl === 'string' && targetUrl.includes('___neosatsu_ep___')) {
        targetUrl = targetUrl.split('___neosatsu_ep___')[0];
    }
    let dbAnime = null;
    
    // Kumpulkan semua URL pencarian
    const searchUrls = new Set();
    if (targetUrl) searchUrls.add(targetUrl);
    for (const url of Object.values(providerUrls)) {
        if (url) searchUrls.add(url);
    }
    
    const urlsArray = Array.from(searchUrls);
    if (urlsArray.length === 0) return null;

    // 1. Cari berdasarkan skema baru sourceUrls
    dbAnime = await Anime.findOne({ sourceUrls: { $in: urlsArray } });

    // 2. Backward Compatibility: Cari berdasarkan skema lama jika belum ketemu
    if (!dbAnime) {
        const legacyOrQuery = urlsArray.map(url => ({ "url": url })); // fallback dasar
        
        for (const provider of Object.values(PROVIDER_URLS)) {
            const pk = provider.NAME.toLowerCase().replace(/[^a-z]/g, '');
            for (const url of urlsArray) {
                legacyOrQuery.push({ [`sources.${pk}.url`]: url });
                legacyOrQuery.push({ [`episodesList.urls.${pk}`]: url });
            }
        }
        
        dbAnime = await Anime.findOne({ $or: legacyOrQuery });
    }

    // 3. AUTO-MIGRATE: Jika data ditemukan tapi masih pakai format lama (sources)
    if (dbAnime && (!dbAnime.sourceUrls || dbAnime.sourceUrls.length === 0)) {
        console.log(`[DB Auto-Migrate] Memindahkan format lama 'sources' ke 'sourceUrls' untuk: ${dbAnime.title}`);
        const newUrls = new Set(dbAnime.sourceUrls || []);
        
        if (dbAnime.url) newUrls.add(dbAnime.url); // Legacy Samehadaku URL
        
        if (dbAnime.sources) {
            if (typeof dbAnime.sources.entries === 'function') {
                for (const [key, obj] of dbAnime.sources.entries()) {
                    if (obj && obj.url) newUrls.add(obj.url);
                }
            } else {
                for (const obj of Object.values(dbAnime.sources)) {
                    if (obj && obj.url) newUrls.add(obj.url);
                }
            }
        }
        
        dbAnime.sourceUrls = Array.from(newUrls);
        
        try {
            await dbAnime.save();
        } catch (e) {
            console.warn('[DB Auto-Migrate] Gagal menyimpan migrasi:', e.message);
        }
    }
    
    return dbAnime;
}

/**
 * Strategy Pattern Gateway: Mendelegasikan scraping berdasarkan provider URL
 * dan menerapkan standarisasi judul & format episode secara terpadu.
 * Jika scraper timeout atau gagal, return kosong agar provider lain tetap bisa dipakai.
 */
async function executeScraperStrategy(targetUrl) {
    if (typeof targetUrl === 'string' && targetUrl.includes('___neosatsu_ep___')) {
        targetUrl = targetUrl.split('___neosatsu_ep___')[0];
    }

    // Identifikasi provider ID dari URL untuk keperluan logika per-provider
    const { getProviderIdFromUrlSync } = await import('./ProviderRegistry.js');
    const providerName = getProviderIdFromUrlSync(targetUrl);
    
    let data;
    try {
        data = await ProviderRegistry.fetchEpisodes(targetUrl);
    } catch (err) {
        console.warn(`[Scraper Factory] ⚠️ Scraper gagal/timeout untuk ${providerName} (${targetUrl}): ${err.message}`);
        return { judul_seri: 'Unknown', daftar_episode: [] };
    }
    
    if (!data) {
        console.warn(`[Scraper Factory] Tidak ada fungsi scraper yang terdaftar untuk URL: ${targetUrl}`);
        return { judul_seri: 'Unknown', daftar_episode: [] };
    }

    // 1. Standarisasi Judul Seri
    data.judul_seri = cleanSeriesTitle(data.judul_seri);

    // 2. Standarisasi & Pembersihan Daftar Episode (Unified Pipeline)
    if (data.daftar_episode && Array.isArray(data.daftar_episode)) {
        data.daftar_episode = data.daftar_episode
            .filter(ep => !ep.judul.toLowerCase().includes('batch'))
            .map(ep => {
                const rawNum = extractEpNum(ep.judul);
                const finalJudul = providerName === 'neosatsu' && typeof rawNum !== 'number' 
                    ? ep.judul 
                    : formatEpisodeTitle(ep.judul);

                return {
                    judul: finalJudul,
                    urls: [ep.url],
                    num: typeof rawNum === 'number' && !isNaN(rawNum) ? rawNum : null
                };
            });
    }

    return data;
}

/**
 * Scrape dari beberapa sumber sekaligus, hitung offset, dan merge episode.
 */
async function scrapeAndMergeMulti({ dbAnime, targetUrl, providerUrls = {} }) {
    const urlsToScrape = new Set();
    
    // 1. Target URL
    if (targetUrl) {
        let finalTargetUrl = targetUrl;
        if (typeof targetUrl === 'string' && targetUrl.includes('___neosatsu_ep___')) {
            finalTargetUrl = targetUrl.split('___neosatsu_ep___')[0];
        }
        urlsToScrape.add(finalTargetUrl);
    }
    
    // 2. Explicit Provider URLs (Zero-Compromise Array)
    const extraUrls = Array.isArray(providerUrls) ? providerUrls : Object.values(providerUrls);
    for (const url of extraUrls) {
        if (url) urlsToScrape.add(url);
    }
    
    // 3. Database URLs
    if (dbAnime && dbAnime.sourceUrls && Array.isArray(dbAnime.sourceUrls)) {
        for (const url of dbAnime.sourceUrls) {
            if (url) urlsToScrape.add(url);
        }
    }

    // TAHAP 2: Independent Scraping secara Paralel menggunakan executeScraperStrategy
    const scrapePromises = Array.from(urlsToScrape).map(url => executeScraperStrategy(url).catch(() => null));
    let allResults = await Promise.all(scrapePromises);
    allResults = allResults.filter(r => r && r.daftar_episode && r.daftar_episode.length > 0);

    // ZERO DATA LOSS FALLBACK: Jika hasil gabungan kosong dan targetUrl belum pernah di-scrape sebelumnya
    if (allResults.length === 0 && targetUrl && !urlsToScrape.has(targetUrl)) {
        console.log(`[Scraper Fallback] Multi-source merge kosong. Mencoba targetUrl yang belum discrape: ${targetUrl}`);
        const fallbackRes = await executeScraperStrategy(targetUrl).catch(() => null);
        if (fallbackRes && fallbackRes.daftar_episode && fallbackRes.daftar_episode.length > 0) {
            allResults.push(fallbackRes);
        }
    }

    // TAHAP 3: Deterministic Merging oleh Nomor Episode (num)
    const epMap = new Map();
    const noNumEps = [];

    for (const res of allResults) {
        for (const ep of res.daftar_episode) {
            const titleLower = (ep.judul || '').toLowerCase().trim();
            const isOvaTitle = /\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)[\s-_]*\d+/i.test(titleLower) || 
                               /\b(?:ova|oad|batch|nced|ncop|movie|film)\b/i.test(titleLower) ||
                               /\((?:ova|oad|special|sp|ex|bonus|nced|ncop)\)|\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)\b\s*$/i.test(titleLower);
            const actualNum = isOvaTitle ? null : ep.num;

            if (actualNum != null && typeof actualNum === 'number' && !isNaN(actualNum)) {
                if (epMap.has(actualNum)) {
                    const existing = epMap.get(actualNum);
                    // Gabungkan array URL
                    const mergedUrls = Array.from(new Set([...(existing.urls || []), ...(ep.urls || [])]));
                    
                    // Bersihkan URL tercemar OVA (opsional, jika perlu di array)
                    existing.urls = mergedUrls.filter(url => !/(?:-|\/)ova(?:-|\/|\b|_)|(?:-|\/)sp(?:-|\/|\b|_)|(?:-|\/)ex(?:-|\/|\b|_)|(?:-|\/)special(?:-|\/|\b|_)|(?:-|\/)bonus(?:-|\/|\b|_)/i.test(url));
                    
                    if (!existing.judul || existing.judul === 'Episode ?' || (!existing.judul.toLowerCase().includes('episode') && ep.judul.toLowerCase().includes('episode'))) {
                        existing.judul = ep.judul;
                    }
                } else {
                    epMap.set(actualNum, {
                        judul: ep.judul || `Episode ${actualNum}`,
                        urls: ep.urls ? [...ep.urls] : [],
                        num: actualNum
                    });
                }
            } else {
                // Untuk Movie / Batch / OVA / Special yang tidak memiliki nomor (num === null)
                const existingNoNum = noNumEps.find(item => (item.judul || '').toLowerCase().trim() === titleLower);
                if (existingNoNum) {
                    existingNoNum.urls = Array.from(new Set([...(existingNoNum.urls || []), ...(ep.urls || [])]));
                } else {
                    noNumEps.push({
                        judul: ep.judul || 'Special / Movie',
                        urls: ep.urls ? [...ep.urls] : [],
                        num: null
                    });
                }
            }
        }
    }

    const mergedEps = Array.from(epMap.values());
    mergedEps.sort((a, b) => b.num - a.num); // Urutkan dari episode terbaru (terbesar) ke terlama (terkecil)

    let finalDaftarEpisode = [...mergedEps, ...noNumEps];
    if (finalDaftarEpisode.length > 0) {
        finalDaftarEpisode = deduplicateEpisodes(finalDaftarEpisode);
    }

    let judulSeri = 'Unknown';
    for (const res of allResults) {
        if (res.judul_seri && res.judul_seri !== 'Unknown') {
            judulSeri = res.judul_seri;
            break;
        }
    }
    
    judulSeri = cleanSeriesTitle(judulSeri === 'Unknown' && dbAnime ? dbAnime.title : judulSeri);

    const data = {
        judul_seri: judulSeri,
        daftar_episode: finalDaftarEpisode
    };

    return finalizeScrapedData(data, dbAnime);
}

/**
 * Helper untuk memvalidasi dan menyimpan hasil scraping ke database serta melengkapi metadata MAL.
 */
async function finalizeScrapedData(data, dbAnime) {
    if (dbAnime && data && data.daftar_episode && data.daftar_episode.length > 0) {
        const oldEpsCount = dbAnime.episodesList ? dbAnime.episodesList.length : 0;
        const newEpsCount = data.daftar_episode.length;
        dbAnime.episodesList = data.daftar_episode;
        // Hanya update lastUpdated jika anime tersebut Ongoing DAN sebelumnya sudah punya episode di DB (bukan sync awal / 0 episode)
        // Mencegah anime lama yang dibuka/ditonton pengguna melompat ke Carousel Anime Terbaru!
        if (newEpsCount > oldEpsCount && oldEpsCount > 0 && dbAnime.status && dbAnime.status.toLowerCase().includes('ongoing')) {
            dbAnime.lastUpdated = new Date();
        }
        try {
            await dbAnime.save();
        } catch (err) {
            console.error('[EpisodeService] Gagal menyimpan update episode ke database:', err.message);
        }
    }

    if (dbAnime && data) {
        data.mal = {
            malScore: dbAnime.malScore && dbAnime.malScore !== '-' ? dbAnime.malScore : dbAnime.score,
            synopsis: dbAnime.synopsis || null,
            status: dbAnime.status,
            genres: dbAnime.genres || [],
            episodes: dbAnime.episodesCount,
            year: dbAnime.year,
            cover: dbAnime.image,
            malId: dbAnime.malId
        };
    }

    return data || { daftar_episode: [] };
}

/**
 * Helper: konversi episodesList dari Mongoose ke plain object
 */
function buildEpisodeData(dbAnime) {
    const rawCleanEpsList = dbAnime.episodesList.map(ep => {
        const epObj = ep.toObject ? ep.toObject({ flattenMaps: true }) : { ...ep };
        if (epObj.urls && (epObj.urls instanceof Map || typeof epObj.urls.entries === 'function')) {
            epObj.urls = Object.fromEntries(epObj.urls);
        }
        return epObj;
    });
    return {
        judul_seri: dbAnime.title,
        daftar_episode: sanitizeContaminatedEpisodeCards(rawCleanEpsList),
        cover_scraper: dbAnime.image,
        mal: {
            malScore: dbAnime.malScore && dbAnime.malScore !== '-' ? dbAnime.malScore : dbAnime.score,
            synopsis: dbAnime.synopsis || null,
            status: dbAnime.status,
            genres: dbAnime.genres || [],
            episodes: dbAnime.episodesCount,
            year: dbAnime.year,
            cover: dbAnime.image,
            malId: dbAnime.malId
        }
    };
}

/**
 * Logika utama dari Service:
 * Prinsip: "serve dulu, refresh belakangan"
 * - Jika episodesList ADA isinya → langsung serve dari DB (tidak peduli provider apa)
 * - Jika data sudah stale (>1 jam) → trigger background refresh tanpa blokir response
 * - Jika episodesList KOSONG → scrape real-time (blokir hingga selesai)
 */
export async function getEpisodeServiceData({ targetUrl, providerUrls = {}, forceRefresh = false }) {
    const dbAnime = await findAnimeInDatabase({ targetUrl, providerUrls });

    const hasEpisodes = dbAnime && dbAnime.episodesList && dbAnime.episodesList.length > 0;

    if (hasEpisodes && !forceRefresh) {
        const cacheAge = Date.now() - new Date(dbAnime.updatedAt || dbAnime.lastUpdated || 0).getTime();
        const isStale = cacheAge > 3600000; // > 1 jam

        // Serve dari DB sekarang — tidak peduli provider apa, tidak peduli umur data
        const data = buildEpisodeData(dbAnime);
        console.log(`[Cache] ✅ Serve dari DB untuk: ${dbAnime.title} (Umur: ${Math.floor(cacheAge / 60000)} menit${isStale ? ' — stale, trigger background refresh' : ''})`);

        if (isStale) {
            // Background refresh: tidak blokir response, scrape di belakang layar
            const lockKey = dbAnime._id.toString();
            if (!activeScrapeLocks.has(lockKey)) {
                const refreshPromise = (async () => {
                    try {
                        await scrapeAndMergeMulti({ dbAnime, targetUrl, providerUrls });
                        console.log(`[Cache] 🔄 Background refresh selesai untuk: ${dbAnime.title}`);
                    } catch (err) {
                        console.warn(`[Cache] Background refresh gagal untuk ${dbAnime.title}: ${err.message}`);
                    } finally {
                        activeScrapeLocks.delete(lockKey);
                    }
                })();
                activeScrapeLocks.set(lockKey, refreshPromise);
            }
        }

        return { status: 'success', data, source: 'database' };
    }

    // episodesList kosong → perlu scrape real-time (first-time load)
    const lockKey = targetUrl || dbAnime?._id?.toString() || 'global_scrape';
    if (activeScrapeLocks.has(lockKey)) {
        console.log(`[EpisodeService] Menunggu scraping yang sedang berjalan (Lock Key: ${lockKey})`);
        const data = await activeScrapeLocks.get(lockKey);
        return { status: 'success', data, source: 'scraper' };
    }

    const scrapePromise = (async () => {
        try {
            const { daftar_episode, judul_seri } = await scrapeAndMergeMulti({ dbAnime, targetUrl, providerUrls });
            return { daftar_episode, judul_seri };
        } finally {
            activeScrapeLocks.delete(lockKey);
        }
    })();

    activeScrapeLocks.set(lockKey, scrapePromise);
    const data = await scrapePromise;
    return { status: 'success', data, source: 'scraper' };
}


