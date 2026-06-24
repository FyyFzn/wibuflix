import express from 'express';
import { getKatalog } from '../controllers/katalogController.js';
import { getHotAnime } from '../controllers/hotController.js';


const router = express.Router();

// ============================================================
// RUTE 1: GET /api/katalog
// ============================================================
router.get('/api/katalog', async (req, res) => {
    const pageParams = parseInt(req.query.page) || 1;
    const searchParam = req.query.s || '';
    const tabParam = req.query.tab || 'all';
    const typeFilter = req.query.typeFilter || '';
    const genreFilter = req.query.genre || '';

    try {
        const data = await getKatalog(pageParams, searchParam, typeFilter, tabParam, genreFilter);
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
