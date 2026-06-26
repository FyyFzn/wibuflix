import { getSamehadakuEpisodes } from './samehadakuController.js';
import { getNeosatsuEpisodes } from './neosatsuController.js';
import * as otakudesu from './otakudesuController.js';
import { getKuronimeEpisodes } from './kuronimeController.js';
import Anime from '../models/Anime.js';
import { formatEpisodeTitle, extractEpNum, adjustTitleEpisodeNumber } from '../utils/stringUtils.js';

export async function getEpisodesMerged(req, res) {
    const targetUrl = req.query.url;
    const urlSamehadaku = req.query.urlSamehadaku;
    const urlOtakudesu = req.query.urlOtakudesu;
    const urlKuronime = req.query.urlKuronime;
    
    if (!targetUrl && !urlSamehadaku && !urlOtakudesu && !urlKuronime) {
        return res.status(400).json({ error: "Parameter 'url' wajib diisi!" });
    }

    try {
        // --- 1. AMBIL METADATA DARI DATABASE LOKAL (SUPER CEPAT) ---
function extractOtakuSlug(val) {
    if (!val) return null;
    if (val.includes(':')) return val.split(':').pop();
    return val.replace(/^\/anime\//, '').replace(/^\//, '');
}

        let dbAnime = null;
        const orQuery = [];
        
        if (urlSamehadaku) orQuery.push({ "sources.samehadaku.url": urlSamehadaku });
        if (urlOtakudesu) {
            const otakuId = extractOtakuSlug(urlOtakudesu);
            if (otakuId) orQuery.push({ "sources.otakudesu.id": otakuId });
        }
        if (urlKuronime) orQuery.push({ "sources.kuronime.url": urlKuronime });
        
        if (orQuery.length > 0) {
            dbAnime = await Anime.findOne({ $or: orQuery });
        } else if (targetUrl) {
            if (targetUrl.startsWith('/anime/') || targetUrl.includes('otakudesu')) {
                const otakuId = extractOtakuSlug(targetUrl);
                if (otakuId) dbAnime = await Anime.findOne({ "sources.otakudesu.id": otakuId });
            } else if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu')) {
                dbAnime = await Anime.findOne({ "sources.neosatsu.url": targetUrl });
            } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/')) {
                dbAnime = await Anime.findOne({ "sources.kuronime.url": targetUrl });
            } else {
                dbAnime = await Anime.findOne({ "sources.samehadaku.url": targetUrl });
            }
        }

        // --- 2. JIKA ADA CACHE DI DATABASE, RETURN LANGSUNG ---
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
            res.json({ status: 'success', data, source: 'database' });
        }

        // --- 3. PROSES SCRAPING (BACKGROUND JIKA SUDAH ADA CACHE) ---
        const performScrape = async () => {
            try {
                let data;
                
                // --- LOGIKA MERGE MULTI-SUMBER ---
        if (urlSamehadaku || urlOtakudesu || urlKuronime) {
            const slug = extractOtakuSlug(urlOtakudesu);
            
            const [sameRes, otakuRes, kuroRes] = await Promise.all([
                urlSamehadaku ? getSamehadakuEpisodes(urlSamehadaku).catch(() => null) : Promise.resolve(null),
                slug ? otakudesu.getOtakuEpisodesFormatted(slug).catch(() => null) : Promise.resolve(null),
                urlKuronime ? getKuronimeEpisodes(urlKuronime).catch(() => null) : Promise.resolve(null),
            ]);
            
            // Format merge
            data = {
                judul_seri: (sameRes && sameRes.judul_seri) || (otakuRes && otakuRes.judul_seri) || (kuroRes && kuroRes.judul_seri) || 'Unknown',
                daftar_episode: []
            };

            // --- DETEKSI OFFSET OTOMATIS ---
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
                    else if (minRef === 1 && minKuro > 1) offsetKuro = 0; // Kuronime yang lanjutan
                }
            }

            // Map berdasarkan angka episode
            const epMap = new Map();

            // Masukkan data Samehadaku
            if (sameRes && sameRes.daftar_episode) {
                sameRes.daftar_episode.forEach(ep => {
                    if (ep.judul.toLowerCase().includes('batch')) return;
                    const rawNum = extractEpNum(ep.judul);
                    const num = typeof rawNum === 'number' ? rawNum + offsetSame : rawNum;
                    const adjustedJudul = typeof rawNum === 'number' ? adjustTitleEpisodeNumber(ep.judul, offsetSame) : ep.judul;
                    
                    epMap.set(num, {
                        judul: formatEpisodeTitle(adjustedJudul), // Pakai judul pendek
                        urls: { samehadaku: ep.url }
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
                            urls: { otakudesu: ep.url }
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
                            urls: { kuronime: ep.url }
                        });
                    }
                });
            }
            
            // Convert Map ke Array dan pastikan terurut menurun (episode terbaru di atas)
            // Episode non-numerik (Moment, OVA, Special, dll.) selalu ditempatkan di AKHIR daftar
            const mergedEps = Array.from(epMap.values());
            mergedEps.sort((a, b) => {
                const numA = extractEpNum(a.judul);
                const numB = extractEpNum(b.judul);
                const aIsNum = typeof numA === 'number';
                const bIsNum = typeof numB === 'number';
                if (aIsNum && bIsNum) return numB - numA; // Keduanya angka: urutan menurun
                if (aIsNum) return -1;  // a angka, b bukan → a lebih dulu (atas)
                if (bIsNum) return 1;   // b angka, a bukan → b lebih dulu (atas)
                return String(numA).localeCompare(String(numB)); // Keduanya string: urut alfabet
            });
            
            data.daftar_episode = mergedEps;

        // --- LOGIKA SINGLE WEB (LAMA) ---
        } else if (targetUrl) {

            if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu-label:') || targetUrl.startsWith('neosatsu-merge:')) {
                data = await getNeosatsuEpisodes(targetUrl);
                // Neosatsu mungkin tidak perlu diformat ekstrem karena sering ada sub-judul, tapi kita filter batch
                if (data && data.daftar_episode) {
                    data.daftar_episode = data.daftar_episode
                        .filter(ep => !ep.judul.toLowerCase().includes('batch'))
                        .map(ep => ({
                            judul: ep.judul,
                            urls: { neosatsu: ep.url }
                        }));
                }
            } else if (targetUrl.startsWith('/anime/') || (targetUrl.includes('otakudesu') && !targetUrl.includes('samehadaku'))) {
                const slug = extractOtakuSlug(targetUrl);
                data = await otakudesu.getOtakuEpisodesFormatted(slug);
                if (!data) return res.status(404).json({ error: "Anime tidak ditemukan di Otakudesu" });
                // Normalisasi agar formatnya sama (menggunakan objek `urls`)
                if (data && data.daftar_episode) {
                    data.daftar_episode = data.daftar_episode
                        .filter(ep => !ep.judul.toLowerCase().includes('batch'))
                        .map(ep => ({
                            judul: formatEpisodeTitle(ep.judul),
                            urls: { otakudesu: ep.url }
                        }));
                }
            } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/')) {
                data = await getKuronimeEpisodes(targetUrl);
                if (data && data.daftar_episode) {
                    data.daftar_episode = data.daftar_episode
                        .filter(ep => !ep.judul.toLowerCase().includes('batch'))
                        .map(ep => ({
                            judul: formatEpisodeTitle(ep.judul),
                            urls: { kuronime: ep.url }
                        }));
                }
            } else {
                data = await getSamehadakuEpisodes(targetUrl);
                // Normalisasi agar formatnya sama (menggunakan objek `urls`)
                if (data && data.daftar_episode) {
                    data.daftar_episode = data.daftar_episode
                        .filter(ep => !ep.judul.toLowerCase().includes('batch'))
                        .map(ep => ({
                            judul: formatEpisodeTitle(ep.judul),
                            urls: { samehadaku: ep.url }
                        }));
                }
            }
        }
        
        // --- DEDUPLIKASI AKHIR: Hapus episode ganda berdasarkan nomor episode ---
        if (data && data.daftar_episode && data.daftar_episode.length > 0) {
            const dedupeMap = new Map();
            for (const ep of data.daftar_episode) {
                const titleLower = ep.judul.toLowerCase().trim();
                const epNumMatch = titleLower.match(/(?:episode|ep|eps)\s*0*(\d+(?:\.\d+)?)/);
                const key = epNumMatch ? `ep_${parseFloat(epNumMatch[1])}` : titleLower;
                
                if (!dedupeMap.has(key)) {
                    dedupeMap.set(key, ep);
                } else {
                    // Sudah ada — merge URLs agar tidak kehilangan source mana pun
                    const existing = dedupeMap.get(key);
                    existing.urls = { ...existing.urls, ...ep.urls };
                }
            }
            data.daftar_episode = Array.from(dedupeMap.values());
        }

        // --- 4. SIMPAN HASIL SCRAPE KE DATABASE UNTUK CACHE BERIKUTNYA ---
        if (dbAnime && data && data.daftar_episode && data.daftar_episode.length > 0) {
            // Jika kita sudah merespons (isCached === true), kita hanya update DB diam-diam
            dbAnime.episodesList = data.daftar_episode;
            dbAnime.lastUpdated = new Date();
            await dbAnime.save().catch(() => {});
        } else if (!dbAnime && data && data.daftar_episode && data.daftar_episode.length > 0) {
            // Jika belum ada di DB (jarang terjadi karena sudah disinkronisasi), tapi siapa tahu
            // Biarkan saja, atau kita bisa buat Anime baru, tapi lebih baik biarkan auto-sync yang handle.
        }

        // Jika belum ada cache, kita return hasil scraping sekarang
        if (!isCached) {
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
            res.json({ status: 'success', data: data || { daftar_episode: [] }, source: 'scraper' });
        }
            } catch (err) {
                console.error('[Background Scrape Error]', err.message);
                if (!isCached) {
                    res.status(500).json({ status: 'error', message: err.message });
                }
            }
        };

        // Jalankan scraping
        if (isCached) {
            const cacheAge = Date.now() - new Date(dbAnime.updatedAt || dbAnime.lastUpdated || 0).getTime();
            if (cacheAge > 86400000) { // 24 jam (sangat basi)
                console.log(`[Cache] Cache sudah >24 jam. Melakukan scraping sinkron untuk: ${dbAnime.title}`);
                await performScrape();
            } else if (cacheAge > 3600000) { // 1 jam
                console.log(`[Cache] Memperbarui episode di latar belakang untuk: ${dbAnime.title}`);
                performScrape(); // Jalan di background tanpa await
            } else {
                console.log(`[Cache] Menggunakan cache episode terbaru untuk: ${dbAnime.title} (Umur: ${Math.floor(cacheAge / 60000)} menit)`);
            }
        } else {
            await performScrape(); // Tunggu jika belum ada cache
        }

    } catch (err) {
        console.error('[Episodes Global Error]', err.message);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
}
