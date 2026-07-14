import express from 'express';
import { scrapeVideoServers, resolveSingleServer } from '../services/extractors/videoExtractor.js';
import * as otakudesu from '../controllers/otakudesuController.js';
import { assertAndRespondContract } from '../utils/contractValidator.js';
import { ProviderRegistry } from '../services/ProviderRegistry.js';

const router = express.Router();

// ============================================================
// RUTE 3: GET /api/scrape?url=URL_EPISODE
// ============================================================
router.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    const urlsParam = req.query.urls;
    const seriesTitle = req.query.series || '';
    const episodeTitle = req.query.episode || '';
    
    if (!targetUrl && !urlsParam) return res.status(400).json({ error: "Parameter 'url' atau 'urls' wajib diisi!" });

    try {
        let data = {
            judul: '',
            servers: [],
            nav_prev: null,
            nav_next: null
        };
        
        let urlsObj = null;
        if (urlsParam) {
            try { urlsObj = JSON.parse(urlsParam); } catch (e) {}
        }

        // --- MULTIPLE URLS SCENARIO ---
        if (urlsObj && typeof urlsObj === 'object') {
            const fetchTasks = [];
            for (const [providerId, provUrl] of Object.entries(urlsObj)) {
                if (!provUrl || typeof provUrl !== 'string') continue;
                const provider = ProviderRegistry.getProviderById(providerId);
                if (provider) {
                    fetchTasks.push(provider.getServers(provUrl).catch(() => null));
                }
            }

            const results = await Promise.all(fetchTasks);
            for (const resData of results) {
                if (!resData) continue;
                if (!data.judul && resData.judul) data.judul = resData.judul || episodeTitle;
                if (!data.nav_prev && resData.nav_prev) data.nav_prev = resData.nav_prev;
                if (!data.nav_next && resData.nav_next) data.nav_next = resData.nav_next;
                if (resData.servers && Array.isArray(resData.servers)) {
                    data.servers = [...data.servers, ...resData.servers];
                }
            }
            if (!data.judul) data.judul = episodeTitle;
            if (!assertAndRespondContract(res, data, 'servers', 'multi-provider')) return;
            return res.json({ status: 'success', data });
        }

        // --- SINGLE URL SCENARIO ---
        const provider = ProviderRegistry.getProviderForUrl(targetUrl);
        data = await provider.getServers(targetUrl);

        // Coba cari alternatif di Otakudesu (Fuzzy Search Fallback)
        if (seriesTitle && episodeTitle && (!data.servers || data.servers.length === 0)) {
            try {
                if (typeof otakudesu.getAlternativeServers === 'function') {
                    const otakuServers = await otakudesu.getAlternativeServers(seriesTitle, episodeTitle);
                    if (otakuServers && otakuServers.length > 0) {
                        const labeledOtaku = otakuServers.map(s => ({ ...s, source: 'Otakudesu' }));
                        data.servers = [...(data.servers || []), ...labeledOtaku];
                    }
                }
            } catch (e) {
                console.warn('[Alternative Otaku Server Fetch Failed]', e.message);
            }
        }
        
        const providerLabel = provider ? provider.name : 'Samehadaku';
        if (!assertAndRespondContract(res, data, 'servers', providerLabel)) return;
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Scrape Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================
// RUTE 4: GET /api/resolve?url=URL_EPISODE&nume=NUME_ID
// ============================================================
router.get('/api/resolve', async (req, res) => {
    const targetUrl = req.query.url;
    const nume = req.query.nume;
    if (!targetUrl || !nume) return res.status(400).json({ error: "Parameter 'url' dan 'nume' wajib diisi!" });

    try {
        const data = await resolveSingleServer(targetUrl, nume, req);
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Resolve Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
