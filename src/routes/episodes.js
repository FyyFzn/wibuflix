import express from 'express';
import { getEpisodes } from '../controllers/episodeController.js';
import { getNeosatsuEpisodes } from '../controllers/neosatsuController.js';
import * as otakudesu from '../controllers/otakudesuController.js';
import { getKuronimeEpisodes } from '../controllers/kuronimeController.js';
import Anime from '../models/Anime.js';

const router = express.Router();

// ============================================================
// RUTE 2: GET /api/episodes?url=URL_ANIME
// ============================================================
router.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    const urlSamehadaku = req.query.urlSamehadaku;
    const urlOtakudesu = req.query.urlOtakudesu;
    const urlKuronime = req.query.urlKuronime;
    
    if (!targetUrl && !urlSamehadaku && !urlOtakudesu && !urlKuronime) {
        return res.status(400).json({ error: "Parameter 'url' wajib diisi!" });
    }

    try {
        let data;
        
        // --- LOGIKA MERGE MULTI-SUMBER ---
        if (urlSamehadaku || urlOtakudesu || urlKuronime) {
            const slug = urlOtakudesu ? urlOtakudesu.split(':')[1] : null;
            
            const [sameRes, otakuRes, kuroRes] = await Promise.all([
                urlSamehadaku ? getEpisodes(urlSamehadaku).catch(() => null) : Promise.resolve(null),
                slug ? otakudesu.getOtakuEpisodesFormatted(slug).catch(() => null) : Promise.resolve(null),
                urlKuronime ? getKuronimeEpisodes(urlKuronime).catch(() => null) : Promise.resolve(null),
            ]);
            
            // Format merge
            data = {
                judul_seri: (sameRes && sameRes.judul_seri) || (otakuRes && otakuRes.judul_seri) || (kuroRes && kuroRes.judul_seri) || 'Unknown',
                daftar_episode: []
            };
            
            const formatEpisodeTitle = (title) => {
                if (!title) return "Episode ?";
                const typeMatch = title.match(/(OVA|OAD|Special|SP)\s*\d*/i);
                if (typeMatch) return typeMatch[0].toUpperCase();
                
                const epMatch = title.match(/(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)/i);
                if (epMatch) return `Episode ${epMatch[1]}`;
                
                // Coba cari angka saja jika tidak ada kata episode
                const numMatch = title.match(/\b(\d+(?:\.\d+)?)\b/);
                if (numMatch) return `Episode ${numMatch[1]}`;
                
                return title;
            };
            
            const extractEpNum = (title) => {
                if (!title) return title;
                // Prioritas 1: ada kata "episode/ep/eps" diikuti angka
                const epMatch = title.match(/(?:episode|ep|eps)\s*0*(\d+(?:\.\d+)?)/i);
                if (epMatch) return parseFloat(epMatch[1]);
                
                // Prioritas 2: judul hanya berisi angka (misal "01", "12")
                const pureNumMatch = title.match(/^\s*0*(\d+(?:\.\d+)?)\s*$/);
                if (pureNumMatch) return parseFloat(pureNumMatch[1]);

                // Tidak cocok → kembalikan judul asli sebagai key string (OVA, Special, dll.)
                return title;
            };

            const adjustTitleEpisodeNumber = (title, offset) => {
                if (!offset) return title;
                const match = title.match(/(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)/i) || title.match(/(\d+(?:\.\d+)?)/);
                if (match) {
                    const originalNumStr = match[1];
                    const originalNum = parseFloat(originalNumStr);
                    const newNum = originalNum + offset;
                    
                    const zeroPaddingLength = originalNumStr.startsWith('0') && originalNumStr.length > 1 ? originalNumStr.length : 0;
                    let newNumStr = String(newNum);
                    if (zeroPaddingLength > 0) {
                        newNumStr = newNumStr.padStart(zeroPaddingLength, '0');
                    }
                    
                    const fullMatch = match[0];
                    const updatedFullMatch = fullMatch.replace(originalNumStr, newNumStr);
                    return title.replace(fullMatch, updatedFullMatch);
                }
                return title;
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
            
            const formatEpisodeTitle = (title) => {
                if (!title) return "Episode ?";
                const typeMatch = title.match(/(OVA|OAD|Special|SP)\s*\d*/i);
                if (typeMatch) return typeMatch[0].toUpperCase();
                
                const epMatch = title.match(/(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)/i);
                if (epMatch) return `Episode ${epMatch[1]}`;
                
                const numMatch = title.match(/\b(\d+(?:\.\d+)?)\b/);
                if (numMatch) return `Episode ${numMatch[1]}`;
                
                return title;
            };

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
            } else if (targetUrl.startsWith('/anime/otakudesu:')) {
                const slug = targetUrl.split(':')[1];
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
                data = await getEpisodes(targetUrl);
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
        // Ini sebagai jaring pengaman terakhir setelah semua path merge selesai.
        // Contoh kasus: Samehadaku "Episode 1" dan "Episode 01" keduanya lolos tapi
        // sebenarnya episode yang sama.
        if (data && data.daftar_episode && data.daftar_episode.length > 0) {
            const dedupeMap = new Map();
            for (const ep of data.daftar_episode) {
                // Buat key dedup: normalkan judul ke format "episode_N" atau gunakan judul apa adanya
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

        // --- AMBIL METADATA DARI DATABASE LOKAL (SUPER CEPAT) ---
        let dbAnime = null;
        const orQuery = [];
        
        if (urlSamehadaku) orQuery.push({ "sources.samehadaku.url": urlSamehadaku });
        if (urlOtakudesu) orQuery.push({ "sources.otakudesu.id": urlOtakudesu.split(':')[1] });
        if (urlKuronime) orQuery.push({ "sources.kuronime.url": urlKuronime });
        
        if (orQuery.length > 0) {
            dbAnime = await Anime.findOne({ $or: orQuery });
        } else if (targetUrl) {
            if (targetUrl.startsWith('/anime/otakudesu:')) {
                dbAnime = await Anime.findOne({ "sources.otakudesu.id": targetUrl.split(':')[1] });
            } else if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu')) {
                dbAnime = await Anime.findOne({ "sources.neosatsu.url": targetUrl });
            } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/')) {
                dbAnime = await Anime.findOne({ "sources.kuronime.url": targetUrl });
            } else {
                dbAnime = await Anime.findOne({ "sources.samehadaku.url": targetUrl });
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
        
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Episodes Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
