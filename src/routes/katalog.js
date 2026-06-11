import express from 'express';
import { getKatalog } from '../scraper/katalog.js';
import { getHotAnime } from '../scraper/hot.js';
import { getNeosatsuCatalog } from '../scraper/neosatsu.js';

const router = express.Router();

// ============================================================
// RUTE 1: GET /api/katalog
// ============================================================
router.get('/api/katalog', async (req, res) => {
    const pageParams = parseInt(req.query.page) || 1;
    const searchParam = req.query.s || '';
    const tabParam = req.query.tab || 'anime';
    const typeFilter = req.query.typeFilter || '';

    try {
        let data = { list: [], hasNext: false };

        if (tabParam === 'anime' || tabParam === 'all') {
            data = await getKatalog(pageParams, searchParam, typeFilter);
        }

        // --- INJEKSI NEOSATSU ---
        if (tabParam === 'toku' || tabParam === 'all') {
            try {
                const neosatsuData = await getNeosatsuCatalog(pageParams, searchParam, typeFilter);
                if (neosatsuData && neosatsuData.anime && Array.isArray(neosatsuData.anime)) {
                    const neosatsuList = neosatsuData.anime.map(w => ({
                        judul: w.title,
                        url: w.endpoint,
                        gambar: w.thumb,
                        gambarScraper: w.thumb,
                        tipe: w.tipe || 'Toku',
                        skor: '-',
                        status: w.status || 'Completed'
                    }));

                    if (tabParam === 'toku') {
                        data.list = neosatsuList;
                        data.hasNext = neosatsuList.length > 0; // Simple pagination indicator
                    } else {
                        // Gabungkan
                        data.list = [...neosatsuList, ...(data.list || [])];
                    }
                }
            } catch (e) {
                console.error('[Inject Neosatsu Error]', e.message);
            }
        }

        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Katalog Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================
// RUTE 1B: GET /api/hot
// ============================================================
router.get('/api/hot', async (req, res) => {
    try {
        const data = await getHotAnime();
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Hot Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
