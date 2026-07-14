import { getSamehadakuEpisodes } from './scrapers/samehadakuScraper.js';
import { getNeosatsuEpisodes } from './scrapers/neosatsuScraperService.js';
import * as otakudesu from './scrapers/otakudesuScraper.js';
import { getKuronimeEpisodes } from './scrapers/kuronimeScraper.js';
import { getNanimeEpisodes } from './scrapers/nanimeScraper.js';
import { getNimegamiEpisodes } from './scrapers/nimegamiScraper.js';
import * as oploverz from './scrapers/oploverzScraper.js';
import Anime from '../models/Anime.js';
import { formatEpisodeTitle, extractEpNum, adjustTitleEpisodeNumber, extractOtakuSlug, cleanSeriesTitle } from '../utils/stringUtils.js';
import { getOploverzSeriesUrl, getKuronimeSeriesUrl, getNanimeSeriesUrl, getNimegamiSeriesUrl } from '../config/providerUrls.js';


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
 * Kalkulasi offset antar scraper (Samehadaku, Otakudesu, Kuronime) untuk penomoran episode yang selaras.
 */
export function calculateOffsets(sameRes, otakuRes, kuroRes, nanimeRes, nimegamiRes, oploverzRes) {
    let offsetSame = 0;
    let offsetOtaku = 0;
    let offsetKuro = 0;
    let offsetNanime = 0;
    let offsetNimegami = 0;
    let offsetOploverz = 0;

    const getValidEpNums = (epsList) => {
        if (!epsList) return [];
        return epsList
            .filter(ep => !ep.judul.toLowerCase().includes('batch'))
            .map(ep => extractEpNum(ep.judul))
            .filter(num => typeof num === 'number' && !isNaN(num));
    };

    const sameEps = getValidEpNums(sameRes?.daftar_episode);
    const otakuEps = getValidEpNums(otakuRes?.daftar_episode);
    const kuroEps = getValidEpNums(kuroRes?.daftar_episode);
    const nanimeEps = getValidEpNums(nanimeRes?.daftar_episode);
    const nimegamiEps = getValidEpNums(nimegamiRes?.daftar_episode);
    const oploverzEps = getValidEpNums(oploverzRes?.daftar_episode);

    // Kalkulasi offset Samehadaku vs Otakudesu
    if (sameEps.length > 0 && otakuEps.length > 0) {
        const minSame = Math.min(...sameEps);
        const minOtaku = Math.min(...otakuEps);
        const sameSet = new Set(sameEps);
        const hasOverlap = otakuEps.some(num => sameSet.has(num));
        if (!hasOverlap) {
            if (minOtaku === 1 && minSame > 1) offsetOtaku = minSame - 1;
            else if (minSame === 1 && minOtaku > 1) offsetSame = minOtaku - 1;
        }
    }

    // Kalkulasi offset Kuronime vs referensi utama (Samehadaku atau Otakudesu)
    const refEps = sameEps.length > 0 ? sameEps : otakuEps;
    if (refEps.length > 0 && kuroEps.length > 0) {
        const minRef = Math.min(...refEps);
        const minKuro = Math.min(...kuroEps);
        const refSet = new Set(refEps);
        const hasOverlap = kuroEps.some(num => refSet.has(num));
        if (!hasOverlap) {
            if (minKuro === 1 && minRef > 1) offsetKuro = minRef - 1;
            else if (minRef === 1 && minKuro > 1) offsetKuro = 0;
        }
    }

    // Kalkulasi offset Nanime vs referensi utama
    if (refEps.length > 0 && nanimeEps.length > 0) {
        const minRef = Math.min(...refEps);
        const minNanime = Math.min(...nanimeEps);
        const refSet = new Set(refEps);
        const hasOverlap = nanimeEps.some(num => refSet.has(num));
        if (!hasOverlap) {
            if (minNanime === 1 && minRef > 1) offsetNanime = minRef - 1;
            else if (minRef === 1 && minNanime > 1) offsetNanime = 0;
        }
    }

    // Kalkulasi offset Nimegami vs referensi utama
    if (refEps.length > 0 && nimegamiEps.length > 0) {
        const minRef = Math.min(...refEps);
        const minNimegami = Math.min(...nimegamiEps);
        const refSet = new Set(refEps);
        const hasOverlap = nimegamiEps.some(num => refSet.has(num));
        if (!hasOverlap) {
            if (minNimegami === 1 && minRef > 1) offsetNimegami = minRef - 1;
            else if (minRef === 1 && minNimegami > 1) offsetNimegami = 0;
        }
    }

    // Kalkulasi offset Oploverz vs referensi utama
    if (refEps.length > 0 && oploverzEps.length > 0) {
        const minRef = Math.min(...refEps);
        const minOploverz = Math.min(...oploverzEps);
        const refSet = new Set(refEps);
        const hasOverlap = oploverzEps.some(num => refSet.has(num));
        if (!hasOverlap) {
            if (minOploverz === 1 && minRef > 1) offsetOploverz = minRef - 1;
            else if (minRef === 1 && minOploverz > 1) offsetOploverz = 0;
        }
    }

    return { offsetSame, offsetOtaku, offsetKuro, offsetNanime, offsetNimegami, offsetOploverz };
}

/**
 * Cari anime di database lokal
 */
export async function findAnimeInDatabase({ targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime, urlNanime, urlNimegami, urlOploverz }) {
    if (typeof targetUrl === 'string' && targetUrl.includes('___neosatsu_ep___')) {
        targetUrl = targetUrl.split('___neosatsu_ep___')[0];
    }
    let dbAnime = null;
    const orQuery = [];
    
    if (urlSamehadaku) {
        orQuery.push({ "sources.samehadaku.url": urlSamehadaku });
        orQuery.push({ "episodesList.urls.samehadaku": urlSamehadaku });
        orQuery.push({ "url": urlSamehadaku });
    }
    if (urlOtakudesu) {
        const otakuId = extractOtakuSlug(urlOtakudesu);
        if (otakuId) {
            orQuery.push({ "sources.otakudesu.id": otakuId });
            orQuery.push({ "episodesList.urls.otakudesu": { $regex: otakuId, $options: 'i' } });
        }
    }
    if (urlKuronime) {
        orQuery.push({ "sources.kuronime.url": urlKuronime });
        orQuery.push({ "episodesList.urls.kuronime": urlKuronime });
    }
    if (urlNanime) {
        orQuery.push({ "sources.nanime.url": urlNanime });
        orQuery.push({ "episodesList.urls.nanime": urlNanime });
    }
    if (urlNimegami) {
        orQuery.push({ "sources.nimegami.url": urlNimegami });
        orQuery.push({ "episodesList.urls.nimegami": urlNimegami });
    }
    if (urlOploverz) {
        orQuery.push({ "sources.oploverz.url": urlOploverz });
        orQuery.push({ "episodesList.urls.oploverz": urlOploverz });
    }
    
    if (orQuery.length > 0) {
        dbAnime = await Anime.findOne({ $or: orQuery });
    }
    if (!dbAnime && targetUrl) {
        if (targetUrl.startsWith('/anime/') || targetUrl.includes('otakudesu')) {
            const otakuId = extractOtakuSlug(targetUrl);
            if (otakuId) dbAnime = await Anime.findOne({ $or: [{ "sources.otakudesu.id": otakuId }, { "episodesList.urls.otakudesu": { $regex: otakuId, $options: 'i' } }] });
        } else if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu')) {
            dbAnime = await Anime.findOne({ $or: [{ "sources.neosatsu.url": targetUrl }, { "episodesList.urls.neosatsu": targetUrl }, { "url": targetUrl }] });
        } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/')) {
            dbAnime = await Anime.findOne({ $or: [{ "sources.kuronime.url": targetUrl }, { "episodesList.urls.kuronime": targetUrl }] });
        } else if (targetUrl.includes('nanimeid.net') || targetUrl.startsWith('/api/nanime/')) {
            dbAnime = await Anime.findOne({ $or: [{ "sources.nanime.url": targetUrl }, { "episodesList.urls.nanime": targetUrl }] });
        } else if (targetUrl.includes('nimegami.id') || targetUrl.startsWith('/api/nimegami/')) {
            dbAnime = await Anime.findOne({ $or: [{ "sources.nimegami.url": targetUrl }, { "episodesList.urls.nimegami": targetUrl }] });
        } else if (targetUrl.includes('oploverz.ltd') || targetUrl.includes('oploverz.site') || targetUrl.startsWith('/api/oploverz/')) {
            dbAnime = await Anime.findOne({ $or: [{ "sources.oploverz.url": targetUrl }, { "episodesList.urls.oploverz": targetUrl }] });
        } else {
            dbAnime = await Anime.findOne({ $or: [{ "sources.samehadaku.url": targetUrl }, { "episodesList.urls.samehadaku": targetUrl }, { "url": targetUrl }] });
        }
    }
    return dbAnime;
}

/**
 * Strategy Pattern Gateway: Mendelegasikan scraping berdasarkan provider URL
 * dan menerapkan standarisasi judul & format episode secara terpadu.
 */
async function executeScraperStrategy(targetUrl) {
    if (typeof targetUrl === 'string' && targetUrl.includes('___neosatsu_ep___')) {
        targetUrl = targetUrl.split('___neosatsu_ep___')[0];
    }
    let data = null;
    let providerName = 'samehadaku';

    if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu-label:') || targetUrl.startsWith('neosatsu-merge:')) {
        providerName = 'neosatsu';
        data = await getNeosatsuEpisodes(targetUrl);
    } else if (targetUrl.startsWith('/anime/') || (targetUrl.includes('otakudesu') && !targetUrl.includes('samehadaku'))) {
        providerName = 'otakudesu';
        const slug = extractOtakuSlug(targetUrl);
        data = await otakudesu.getOtakuEpisodesFormatted(slug);
        if (!data) throw new Error("Anime tidak ditemukan di Otakudesu");
    } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/')) {
        providerName = 'kuronime';
        data = await getKuronimeEpisodes(targetUrl);
    } else if (targetUrl.includes('nanimeid.net') || targetUrl.startsWith('/api/nanime/')) {
        providerName = 'nanime';
        data = await getNanimeEpisodes(targetUrl);
    } else if (targetUrl.includes('nimegami.id') || targetUrl.startsWith('/api/nimegami/')) {
        providerName = 'nimegami';
        data = await getNimegamiEpisodes(targetUrl);
    } else if (targetUrl.includes('oploverz.ltd') || targetUrl.includes('oploverz.site') || targetUrl.startsWith('/api/oploverz/')) {
        providerName = 'oploverz';
        data = await oploverz.getOploverzEpisodes(targetUrl);
    } else {
        providerName = 'samehadaku';
        data = await getSamehadakuEpisodes(targetUrl);
    }

    if (!data) return { judul_seri: 'Unknown', daftar_episode: [] };

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
                    urls: { [providerName]: ep.url },
                    num: typeof rawNum === 'number' && !isNaN(rawNum) ? rawNum : null
                };
            });
    }

    return data;
}

/**
 * Scrape dari beberapa sumber sekaligus, hitung offset, dan merge episode.
 */
async function scrapeAndMergeMulti({ dbAnime, targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime, urlNanime, urlNimegami, urlOploverz }) {
    // TAHAP 1: Source Resolution (Ambil URL seri resmi dari database atau parameter input)
    let cleanSamehadaku = urlSamehadaku || dbAnime?.sources?.samehadaku?.url;
    let cleanOtakudesu = urlOtakudesu || dbAnime?.sources?.otakudesu?.url || (dbAnime?.sources?.otakudesu?.id ? `/anime/${dbAnime.sources.otakudesu.id.replace(/^otakudesu:/, '')}` : null);
    let cleanKuronime = urlKuronime || dbAnime?.sources?.kuronime?.url || (dbAnime?.sources?.kuronime?.id ? getKuronimeSeriesUrl(dbAnime.sources.kuronime.id.replace(/^kuronime:/, '')) : null);
    let cleanNanime = urlNanime || dbAnime?.sources?.nanime?.url || (dbAnime?.sources?.nanime?.id ? getNanimeSeriesUrl(dbAnime.sources.nanime.id) : null);
    let cleanNimegami = urlNimegami || dbAnime?.sources?.nimegami?.url || (dbAnime?.sources?.nimegami?.id ? getNimegamiSeriesUrl(dbAnime.sources.nimegami.id.replace(/^nimegami:/, '')) : null);
    let cleanOploverz = urlOploverz || dbAnime?.sources?.oploverz?.url || (dbAnime?.sources?.oploverz?.id ? getOploverzSeriesUrl(dbAnime.sources.oploverz.id) : null);


    let cleanNeosatsu = dbAnime?.sources?.neosatsu?.url || (typeof targetUrl === 'string' && targetUrl.includes('neosatsu') ? (targetUrl.includes('___neosatsu_ep___') ? targetUrl.split('___neosatsu_ep___')[0] : targetUrl) : null);

    if (targetUrl) {
        if ((targetUrl.includes('samehadaku') || targetUrl.includes('v2.samehadaku')) && !cleanSamehadaku) cleanSamehadaku = targetUrl;
        else if ((targetUrl.includes('otakudesu') || targetUrl.startsWith('/anime/')) && !cleanOtakudesu) cleanOtakudesu = targetUrl;
        else if (targetUrl.includes('kuronime') && !cleanKuronime) cleanKuronime = targetUrl;
        else if (targetUrl.includes('nanime') && !cleanNanime) cleanNanime = targetUrl;
        else if (targetUrl.includes('nimegami') && !cleanNimegami) cleanNimegami = targetUrl;
        else if (targetUrl.includes('oploverz') && !cleanOploverz) cleanOploverz = targetUrl;
        else if (targetUrl.includes('neosatsu') && !cleanSamehadaku && !cleanOtakudesu && !cleanKuronime && !cleanNanime && !cleanNimegami && !cleanOploverz && !cleanNeosatsu) {
            cleanNeosatsu = targetUrl.includes('___neosatsu_ep___') ? targetUrl.split('___neosatsu_ep___')[0] : targetUrl;
        }
    }

    // TAHAP 2: Independent Scraping secara Paralel menggunakan executeScraperStrategy
    const [sameRes, otakuRes, kuroRes, nanimeRes, nimegamiRes, oploverzRes, neosatsuRes] = await Promise.all([
        cleanSamehadaku ? executeScraperStrategy(cleanSamehadaku).catch(() => null) : Promise.resolve(null),
        cleanOtakudesu ? executeScraperStrategy(cleanOtakudesu).catch(() => null) : Promise.resolve(null),
        cleanKuronime ? executeScraperStrategy(cleanKuronime).catch(() => null) : Promise.resolve(null),
        cleanNanime ? executeScraperStrategy(cleanNanime).catch(() => null) : Promise.resolve(null),
        cleanNimegami ? executeScraperStrategy(cleanNimegami).catch(() => null) : Promise.resolve(null),
        cleanOploverz ? executeScraperStrategy(cleanOploverz).catch(() => null) : Promise.resolve(null),
        cleanNeosatsu ? executeScraperStrategy(cleanNeosatsu).catch(() => null) : Promise.resolve(null),
    ]);

    const allResults = [sameRes, otakuRes, kuroRes, nanimeRes, nimegamiRes, oploverzRes, neosatsuRes].filter(r => r && r.daftar_episode && r.daftar_episode.length > 0);

    // ZERO DATA LOSS FALLBACK: Jika hasil gabungan kosong tapi targetUrl ada, ambil langsung
    if (allResults.length === 0 && targetUrl) {
        console.log(`[Scraper Fallback] Multi-source merge mengembalikan 0 episode. Mengambil langsung dari targetUrl: ${targetUrl}`);
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
                    // Hanya merge URL yang tidak tercemar pola OVA
                    const cleanIncomingUrls = {};
                    for (const [prov, provUrl] of Object.entries(ep.urls || {})) {
                        if (typeof provUrl === 'string' && !/(?:-|\/)ova(?:-|\/|\b|_)|(?:-|\/)sp(?:-|\/|\b|_)|(?:-|\/)ex(?:-|\/|\b|_)|(?:-|\/)special(?:-|\/|\b|_)|(?:-|\/)bonus(?:-|\/|\b|_)/i.test(provUrl)) {
                            cleanIncomingUrls[prov] = provUrl;
                        }
                    }
                    existing.urls = { ...existing.urls, ...cleanIncomingUrls };
                    if (!existing.judul || existing.judul === 'Episode ?' || (!existing.judul.toLowerCase().includes('episode') && ep.judul.toLowerCase().includes('episode'))) {
                        existing.judul = ep.judul;
                    }
                } else {
                    epMap.set(actualNum, {
                        judul: ep.judul || `Episode ${actualNum}`,
                        urls: { ...ep.urls },
                        num: actualNum
                    });
                }
            } else {
                // Untuk Movie / Batch / OVA / Special yang tidak memiliki nomor (num === null)
                const existingNoNum = noNumEps.find(item => (item.judul || '').toLowerCase().trim() === titleLower);
                if (existingNoNum) {
                    existingNoNum.urls = { ...existingNoNum.urls, ...ep.urls };
                } else {
                    noNumEps.push({
                        judul: ep.judul || 'Special / Movie',
                        urls: { ...ep.urls },
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

    const judulSeri = cleanSeriesTitle(
        (sameRes?.judul_seri) ||
        (otakuRes?.judul_seri) ||
        (kuroRes?.judul_seri) ||
        (nanimeRes?.judul_seri) ||
        (nimegamiRes?.judul_seri) ||
        (oploverzRes?.judul_seri) ||
        dbAnime?.title ||
        'Unknown'
    );

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
 * Logika utama dari Service:
 * Mengambil episode dari database (jika ada & masih relevan) atau menjalankan scraping real-time.
 */
export async function getEpisodeServiceData({ targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime, urlNanime, urlNimegami, urlOploverz, forceRefresh = false }) {
    const dbAnime = await findAnimeInDatabase({ targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime, urlNanime, urlNimegami, urlOploverz });

    if (dbAnime && dbAnime.episodesList && dbAnime.episodesList.length > 0 && !forceRefresh) {
        const cacheAge = Date.now() - new Date(dbAnime.updatedAt || dbAnime.lastUpdated || 0).getTime();
        
        if (cacheAge <= 3600000) {
            console.log(`[Cache] Menggunakan cache episode terbaru untuk: ${dbAnime.title} (Umur: ${Math.floor(cacheAge / 60000)} menit)`);
            const rawCleanEpsList = dbAnime.episodesList.map(ep => {
                const epObj = ep.toObject ? ep.toObject({ flattenMaps: true }) : { ...ep };
                if (epObj.urls && (epObj.urls instanceof Map || typeof epObj.urls.entries === 'function')) {
                    epObj.urls = Object.fromEntries(epObj.urls);
                }
                return epObj;
            });
            const cleanEpsList = sanitizeContaminatedEpisodeCards(rawCleanEpsList);
            const data = {
                judul_seri: dbAnime.title,
                daftar_episode: cleanEpsList,
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

            return { status: 'success', data, source: 'database' };
        }
    }

    const lockKey = targetUrl || dbAnime?._id?.toString() || urlSamehadaku || urlOtakudesu || 'global_scrape';
    if (activeScrapeLocks.has(lockKey)) {
        console.log(`[EpisodeService] Menggunakan hasil dari scraping yang sedang berjalan (Lock Key: ${lockKey})`);
        const data = await activeScrapeLocks.get(lockKey);
        return { status: 'success', data, source: 'scraper' };
    }

    const scrapePromise = (async () => {
        try {
            return await scrapeAndMergeMulti({ dbAnime, targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime, urlNanime, urlNimegami, urlOploverz });
        } finally {
            activeScrapeLocks.delete(lockKey);
        }
    })();

    activeScrapeLocks.set(lockKey, scrapePromise);
    const data = await scrapePromise;
    return { status: 'success', data, source: 'scraper' };
}
