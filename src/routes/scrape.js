import express from 'express';
import { scrapeVideoServers, resolveSingleServer } from '../services/extractors/videoExtractor.js';
import { getNeosatsuServers } from '../controllers/neosatsuController.js';
import * as otakudesu from '../controllers/otakudesuController.js';

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
            try {
                urlsObj = JSON.parse(urlsParam);
            } catch (e) {}
        }

        // --- MULTIPLE URLS SCENARIO ---
        if (urlsObj && urlsObj.samehadaku && urlsObj.otakudesu) {
            // urlsObj.otakudesu is often in the format: /api/otakudesu/servers?url=https...
            let realOtakuUrl = urlsObj.otakudesu;
            if (realOtakuUrl.startsWith('/api/otakudesu/servers')) {
                realOtakuUrl = new URL('http://localhost' + realOtakuUrl).searchParams.get('url') || realOtakuUrl;
            }

            const [sameRes, otakuRes] = await Promise.all([
                scrapeVideoServers(urlsObj.samehadaku).catch(() => null),
                otakudesu.getServersInternal(realOtakuUrl).catch(() => null)
            ]);
            
            if (sameRes) {
                data.judul = sameRes.judul || episodeTitle;
                data.nav_prev = sameRes.nav_prev;
                data.nav_next = sameRes.nav_next;
                if (sameRes.servers) {
                    data.servers = [...data.servers, ...sameRes.servers.map(s => ({ ...s, source: 'Samehadaku' }))];
                }
            }
            if (otakuRes) {
                if (!data.judul) data.judul = otakuRes.judul || episodeTitle;
                // Prefer Samehadaku navigation if available
                if (!data.nav_prev) data.nav_prev = otakuRes.nav_prev;
                if (!data.nav_next) data.nav_next = otakuRes.nav_next;
                if (otakuRes.servers) {
                    data.servers = [...data.servers, ...otakuRes.servers.map(s => ({ ...s, source: 'Otakudesu' }))];
                }
            }
            
            return res.json({ status: 'success', data });
        }

        // --- SINGLE URL SCENARIO (LAMA) ---
        let isOtakudesu = false;

        if (targetUrl.startsWith('/api/otakudesu/servers')) {
            isOtakudesu = true;
            const urlParam = new URL('http://localhost' + targetUrl).searchParams.get('url');
            if (urlParam) {
                data = await otakudesu.getServersInternal(urlParam);
                if (data && data.servers) {
                    data.servers = data.servers.map(s => ({ ...s, source: 'Otakudesu' }));
                }
            }
        }

        if ((targetUrl.includes('neosatsu.com') || targetUrl.startsWith('neosatsu-label:') || targetUrl.startsWith('neosatsu-merge:')) && targetUrl.includes('___neosatsu_ep___')) {
            const neoData = await getNeosatsuServers(targetUrl);
            data = {
                judul: neoData.judul || 'Tokusatsu',
                judul_seri: neoData.judul_seri || neoData.judul || 'Tokusatsu',
                cover_scraper: neoData.cover_scraper || '',
                nav_prev: neoData.nav_prev,
                nav_next: neoData.nav_next,
                servers: neoData.servers.map(s => ({ ...s, source: 'Neosatsu' }))
            };
        } else if (!isOtakudesu && targetUrl) {
            data = await scrapeVideoServers(targetUrl);
            if (data && data.servers) {
                data.servers = data.servers.map(s => ({ ...s, source: 'Samehadaku' }));
            }

            // Coba cari alternatif di Otakudesu (Fuzzy Search Fallback)
            if (seriesTitle && episodeTitle) {
                const otakuServers = await otakudesu.getAlternativeServers(seriesTitle, episodeTitle);
                if (otakuServers && otakuServers.length > 0) {
                    const labeledOtaku = otakuServers.map(s => ({ ...s, source: 'Otakudesu' }));
                    data.servers = [...data.servers, ...labeledOtaku];
                }
            }
        }
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
