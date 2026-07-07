import { getSamehadakuEpisodes } from '../controllers/samehadakuController.js';
import { getNeosatsuEpisodes } from '../controllers/neosatsuController.js';
import * as otakudesu from '../controllers/otakudesuController.js';
import { getKuronimeEpisodes } from '../controllers/kuronimeController.js';
import Anime from '../models/Anime.js';
import { formatEpisodeTitle, extractEpNum, adjustTitleEpisodeNumber, extractOtakuSlug, cleanSeriesTitle } from '../utils/stringUtils.js';

const activeScrapeLocks = new Map();

/**
 * Mencegah episode ganda berdasarkan nomor atau judul episode dan me-merge URL dari berbagai provider.
 */
export function deduplicateEpisodes(episodes) {
    if (!episodes || !Array.isArray(episodes) || episodes.length === 0) return [];
    const dedupeMap = new Map();
    for (const ep of episodes) {
        const titleLower = (ep.judul || '').toLowerCase().trim();
        const epNum = extractEpNum(ep.judul);
        const key = typeof epNum === 'number' && !isNaN(epNum) ? `ep_${epNum}` : titleLower;
        
        if (!dedupeMap.has(key)) {
            dedupeMap.set(key, { ...ep });
        } else {
            const existing = dedupeMap.get(key);
            existing.urls = { ...existing.urls, ...ep.urls };
            if (existing.num == null && ep.num != null) {
                existing.num = ep.num;
            }
        }
    }
    return Array.from(dedupeMap.values());
}

/**
 * Kalkulasi offset antar scraper (Samehadaku, Otakudesu, Kuronime) untuk penomoran episode yang selaras.
 */
export function calculateOffsets(sameRes, otakuRes, kuroRes) {
    let offsetSame = 0;
    let offsetOtaku = 0;
    let offsetKuro = 0;

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

    return { offsetSame, offsetOtaku, offsetKuro };
}

/**
 * Cari anime di database lokal
 */
export async function findAnimeInDatabase({ targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime }) {
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
    
    if (orQuery.length > 0) {
        dbAnime = await Anime.findOne({ $or: orQuery });
    }
    if (!dbAnime && targetUrl) {
        if (targetUrl.startsWith('/anime/') || targetUrl.includes('otakudesu')) {
            const otakuId = extractOtakuSlug(targetUrl);
            if (otakuId) dbAnime = await Anime.findOne({ $or: [{ "sources.otakudesu.id": otakuId }, { "episodesList.urls.otakudesu": { $regex: otakuId, $options: 'i' } }] });
        } else if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu')) {
            dbAnime = await Anime.findOne({ "sources.neosatsu.url": targetUrl });
        } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/')) {
            dbAnime = await Anime.findOne({ $or: [{ "sources.kuronime.url": targetUrl }, { "episodesList.urls.kuronime": targetUrl }] });
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
async function scrapeAndMergeMulti({ dbAnime, targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime }) {
    let data;
    let cleanSamehadaku = urlSamehadaku;
    let cleanOtakudesu = urlOtakudesu;
    let cleanKuronime = urlKuronime;

    if (dbAnime && dbAnime.sources) {
        if (dbAnime.sources.samehadaku?.url) cleanSamehadaku = dbAnime.sources.samehadaku.url;
        if (dbAnime.sources.otakudesu?.id) cleanOtakudesu = `/anime/${dbAnime.sources.otakudesu.id}`;
        else if (dbAnime.sources.otakudesu?.url) cleanOtakudesu = dbAnime.sources.otakudesu.url;
        if (dbAnime.sources.kuronime?.url) cleanKuronime = dbAnime.sources.kuronime.url;
    }

    if (cleanSamehadaku || cleanOtakudesu || cleanKuronime) {
        const slug = extractOtakuSlug(cleanOtakudesu);
        
        const [sameRes, otakuRes, kuroRes] = await Promise.all([
            cleanSamehadaku ? getSamehadakuEpisodes(cleanSamehadaku).catch(() => null) : Promise.resolve(null),
            slug ? otakudesu.getOtakuEpisodesFormatted(slug).catch(() => null) : Promise.resolve(null),
            cleanKuronime ? getKuronimeEpisodes(cleanKuronime).catch(() => null) : Promise.resolve(null),
        ]);
        
        data = {
            judul_seri: cleanSeriesTitle((sameRes && sameRes.judul_seri) || (otakuRes && otakuRes.judul_seri) || (kuroRes && kuroRes.judul_seri) || 'Unknown'),
            daftar_episode: []
        };

        const { offsetSame, offsetOtaku, offsetKuro } = calculateOffsets(sameRes, otakuRes, kuroRes);
        const epMap = new Map();

        // Masukkan data Samehadaku
        if (sameRes && sameRes.daftar_episode) {
            sameRes.daftar_episode.forEach(ep => {
                if (ep.judul.toLowerCase().includes('batch')) return;
                const rawNum = extractEpNum(ep.judul);
                const num = typeof rawNum === 'number' ? rawNum + offsetSame : rawNum;
                const adjustedJudul = typeof rawNum === 'number' ? adjustTitleEpisodeNumber(ep.judul, offsetSame) : ep.judul;
                
                epMap.set(num, {
                    judul: formatEpisodeTitle(adjustedJudul),
                    urls: { samehadaku: ep.url },
                    num: typeof num === 'number' && !isNaN(num) ? num : null
                });
            });
        }
        
        // Gabungkan/Tambahkan data Otakudesu
        if (otakuRes && otakuRes.daftar_episode) {
            otakuRes.daftar_episode.forEach(ep => {
                if (ep.judul.toLowerCase().includes('batch')) return;
                const rawNum = extractEpNum(ep.judul);
                const num = typeof rawNum === 'number' ? rawNum + offsetOtaku : rawNum;
                
                if (epMap.has(num)) {
                    const existing = epMap.get(num);
                    existing.urls.otakudesu = ep.url;
                } else {
                    const adjustedJudul = typeof rawNum === 'number' ? adjustTitleEpisodeNumber(ep.judul, offsetOtaku) : ep.judul;
                    epMap.set(num, {
                        judul: formatEpisodeTitle(adjustedJudul),
                        urls: { otakudesu: ep.url },
                        num: typeof num === 'number' && !isNaN(num) ? num : null
                    });
                }
            });
        }

        // Gabungkan/Tambahkan data Kuronime
        if (kuroRes && kuroRes.daftar_episode) {
            kuroRes.daftar_episode.forEach(ep => {
                if (ep.judul.toLowerCase().includes('batch')) return;
                const rawNum = extractEpNum(ep.judul);
                const num = typeof rawNum === 'number' ? rawNum + offsetKuro : rawNum;
                const adjustedJudul = typeof rawNum === 'number'
                    ? adjustTitleEpisodeNumber(ep.judul, offsetKuro)
                    : ep.judul;

                if (epMap.has(num)) {
                    const existing = epMap.get(num);
                    existing.urls.kuronime = ep.url;
                } else {
                    epMap.set(num, {
                        judul: formatEpisodeTitle(adjustedJudul),
                        urls: { kuronime: ep.url },
                        num: typeof num === 'number' && !isNaN(num) ? num : null
                    });
                }
            });
        }
        
        const mergedEps = Array.from(epMap.values());
        mergedEps.sort((a, b) => {
            const numA = extractEpNum(a.judul);
            const numB = extractEpNum(b.judul);
            const aIsNum = typeof numA === 'number';
            const bIsNum = typeof numB === 'number';
            if (aIsNum && bIsNum) return numB - numA;
            if (aIsNum) return -1;
            if (bIsNum) return 1;
            return String(numA).localeCompare(String(numB));
        });
        
        data.daftar_episode = mergedEps;
    } else if (targetUrl) {
        data = await executeScraperStrategy(targetUrl);
    }

    if (data && data.daftar_episode && data.daftar_episode.length > 0) {
        data.daftar_episode = deduplicateEpisodes(data.daftar_episode);
    }

    // Simpan ke database jika dbAnime ada
    if (dbAnime && data && data.daftar_episode && data.daftar_episode.length > 0) {
        const oldEpsCount = dbAnime.episodesList ? dbAnime.episodesList.length : 0;
        const newEpsCount = data.daftar_episode.length;
        dbAnime.episodesList = data.daftar_episode;
        if (newEpsCount > oldEpsCount) {
            dbAnime.lastUpdated = new Date();
        }
        await dbAnime.save().catch(() => {});
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
export async function getEpisodeServiceData({ targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime }) {
    const dbAnime = await findAnimeInDatabase({ targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime });
    let isCached = false;

    if (dbAnime && dbAnime.episodesList && dbAnime.episodesList.length > 0) {
        isCached = true;
        const data = {
            judul_seri: dbAnime.title,
            daftar_episode: dbAnime.episodesList,
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

        const cacheAge = Date.now() - new Date(dbAnime.updatedAt || dbAnime.lastUpdated || 0).getTime();
        if (cacheAge > 86400000) {
            console.log(`[Cache] Cache sudah >24 jam. Melakukan scraping pembaruan untuk: ${dbAnime.title}`);
            scrapeAndMergeMulti({ dbAnime, targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime }).catch(err => {
                console.error('[Background Scrape Error >24h]', err.message);
            });
        } else if (cacheAge > 3600000) {
            const lockKey = targetUrl || dbAnime._id.toString();
            if (!activeScrapeLocks.has(lockKey)) {
                console.log(`[Cache] Memperbarui episode di latar belakang untuk: ${dbAnime.title}`);
                const scrapePromise = scrapeAndMergeMulti({ dbAnime, targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime })
                    .finally(() => activeScrapeLocks.delete(lockKey));
                activeScrapeLocks.set(lockKey, scrapePromise);
            } else {
                console.log(`[Cache] Scrape latar belakang untuk ${dbAnime.title} sudah berjalan, melewati...`);
            }
        } else {
            console.log(`[Cache] Menggunakan cache episode terbaru untuk: ${dbAnime.title} (Umur: ${Math.floor(cacheAge / 60000)} menit)`);
        }

        return { status: 'success', data, source: 'database' };
    }

    // Jika belum ada di cache, jalankan scraping langsung
    const data = await scrapeAndMergeMulti({ dbAnime, targetUrl, urlSamehadaku, urlOtakudesu, urlKuronime });
    return { status: 'success', data, source: 'scraper' };
}
