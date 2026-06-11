import express from 'express';
import { getEpisodes } from '../scraper/episodes.js';
import { getNeosatsuEpisodes } from '../scraper/neosatsu.js';
import * as otakudesu from '../scraper/otakudesu_controller.js';

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
            
            // Map berdasarkan angka episode
            const epMap = new Map();
            
            const extractEpNum = (title) => {
                const match = title.match(/(?:episode|ep|eps)\s*0*(\d+(?:\.\d+)?)/i) || title.match(/0*(\d+(?:\.\d+)?)/);
                return match ? parseFloat(match[1]) : title;
            };

            // Masukkan data Samehadaku
            if (sameRes && sameRes.daftar_episode) {
                sameRes.daftar_episode.forEach(ep => {
                    if (ep.judul.toLowerCase().includes('batch')) return;
                    const num = extractEpNum(ep.judul);
                    epMap.set(num, {
                        judul: ep.judul, // Pakai judul Samehadaku sbg default
                        tanggal: ep.tanggal,
                        urls: { samehadaku: ep.url }
                    });
                });
            }
            
            // Gabungkan/Tambahkan data Otakudesu
            if (otakuRes && otakuRes.daftar_episode) {
                otakuRes.daftar_episode.forEach(ep => {
                    if (ep.judul.toLowerCase().includes('batch')) return;
                    const num = extractEpNum(ep.judul);
                    if (epMap.has(num)) {
                        const existing = epMap.get(num);
                        existing.urls.otakudesu = ep.url;
                    } else {
                        epMap.set(num, {
                            judul: ep.judul, // Jika cuma ada di Otaku
                            tanggal: ep.tanggal,
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
            if (targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu-label:') || targetUrl.startsWith('neosatsu-merge:')) {
                data = await getNeosatsuEpisodes(targetUrl);
            } else if (targetUrl.startsWith('/anime/otakudesu:')) {
                const slug = targetUrl.split(':')[1];
                data = await otakudesu.getOtakuEpisodesFormatted(slug);
                if (!data) return res.status(404).json({ error: "Anime tidak ditemukan di Otakudesu" });
                // Normalisasi agar formatnya sama (menggunakan objek `urls`)
                if (data && data.daftar_episode) {
                    data.daftar_episode = data.daftar_episode.map(ep => ({
                        judul: ep.judul,
                        tanggal: ep.tanggal,
                        urls: { otakudesu: ep.url }
                    }));
                }
            } else {
                data = await getEpisodes(targetUrl);
                // Normalisasi agar formatnya sama (menggunakan objek `urls`)
                if (data && data.daftar_episode) {
                    data.daftar_episode = data.daftar_episode.map(ep => ({
                        judul: ep.judul,
                        tanggal: ep.tanggal,
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
