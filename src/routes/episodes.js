import express from 'express';
import { getEpisodes } from '../controllers/episodeController.js';
import { getNeosatsuEpisodes } from '../controllers/neosatsuController.js';
import * as otakudesu from '../controllers/otakudesuController.js';

const router = express.Router();

// ============================================================
// RUTE 2: GET /api/episodes?url=URL_ANIME
// ============================================================
router.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    const urlSamehadaku = req.query.urlSamehadaku;
    const urlOtakudesu = req.query.urlOtakudesu;
    
    if (!targetUrl && !urlSamehadaku && !urlOtakudesu) {
        return res.status(400).json({ error: "Parameter 'url' wajib diisi!" });
    }

    try {
        let data;
        
        // --- LOGIKA MERGE 2 WEB ---
        if (urlSamehadaku && urlOtakudesu) {
            const slug = urlOtakudesu.split(':')[1];
            
            const [sameRes, otakuRes] = await Promise.all([
                getEpisodes(urlSamehadaku).catch(() => null),
                otakudesu.getOtakuEpisodesFormatted(slug).catch(() => null)
            ]);
            
            // Format merge
            data = {
                judul_seri: (sameRes && sameRes.judul_seri) || (otakuRes && otakuRes.judul_seri) || 'Unknown',
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
                const match = title.match(/(?:episode|ep|eps)\s*0*(\d+(?:\.\d+)?)/i) || title.match(/0*(\d+(?:\.\d+)?)/);
                return match ? parseFloat(match[1]) : title;
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

            const getValidEpNums = (epsList) => {
                if (!epsList) return [];
                return epsList
                    .filter(ep => !ep.judul.toLowerCase().includes('batch'))
                    .map(ep => extractEpNum(ep.judul))
                    .filter(num => typeof num === 'number' && !isNaN(num));
            };

            const sameEps = getValidEpNums(sameRes?.daftar_episode);
            const otakuEps = getValidEpNums(otakuRes?.daftar_episode);

            if (sameEps.length > 0 && otakuEps.length > 0) {
                const minSame = Math.min(...sameEps);
                const minOtaku = Math.min(...otakuEps);

                const sameSet = new Set(sameEps);
                const hasOverlap = otakuEps.some(num => sameSet.has(num));

                if (!hasOverlap) {
                    if (minOtaku === 1 && minSame > 1) {
                        offsetOtaku = minSame - 1;
                    } else if (minSame === 1 && minOtaku > 1) {
                        offsetSame = minOtaku - 1;
                    }
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
                            judul: formatEpisodeTitle(adjustedJudul), // Jika cuma ada di Otaku
                            urls: { otakudesu: ep.url }
                        });
                    }
                });
            }
            
            // Convert Map ke Array dan pastikan terurut menurun (episode terbaru di atas)
            const mergedEps = Array.from(epMap.values());
            mergedEps.sort((a, b) => {
                const numA = extractEpNum(a.judul);
                const numB = extractEpNum(b.judul);
                if (typeof numA === 'number' && typeof numB === 'number') return numB - numA;
                return 0;
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
        
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Episodes Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
