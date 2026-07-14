import express from 'express';
import { ProviderRegistry } from '../services/ProviderRegistry.js';
import { assertAndRespondContract } from '../utils/contractValidator.js';

const router = express.Router();

// =====================================
// SAMEHADAKU ROUTES (Dedicated API)
// =====================================

router.get('/api/samehadaku/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: "Parameter 'url' wajib diisi untuk Samehadaku!" });
    }

    try {
        const provider = ProviderRegistry.getProviderById('samehadaku');
        const data = await provider.getEpisodes(targetUrl);
        if (!assertAndRespondContract(res, data, 'episodes', 'Samehadaku')) return;
        res.json({ status: 'success', data, source: 'Samehadaku' });
    } catch (err) {
        console.error('[Samehadaku Episodes Error]', err.message);
        const statusCode = err.message && err.message.includes("tidak ditemukan") ? 404 : 500;
        res.status(statusCode).json({ status: 'error', message: err.message });
    }
});

router.get('/api/samehadaku/servers', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: "Parameter 'url' wajib diisi untuk Samehadaku!" });
    }

    try {
        const provider = ProviderRegistry.getProviderById('samehadaku');
        const data = await provider.getServers(targetUrl);
        if (!assertAndRespondContract(res, data, 'servers', 'Samehadaku')) return;
        res.json({ status: 'success', data, source: 'Samehadaku' });
    } catch (err) {
        console.error('[Samehadaku Servers Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
