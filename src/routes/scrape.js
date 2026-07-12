import express from 'express';
import { scrapeVideoServers, resolveSingleServer } from '../services/extractors/videoExtractor.js';
import { getNeosatsuServers } from '../services/scrapers/neosatsuScraperService.js';
import * as otakudesu from '../controllers/otakudesuController.js';
import { getKuronimeServers } from '../controllers/kuronimeController.js';
import { getOploverzServers } from '../controllers/oploverzController.js';
import { assertAndRespondContract } from '../utils/contractValidator.js';

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
        if (urlsObj && (urlsObj.samehadaku || urlsObj.otakudesu || urlsObj.kuronime || urlsObj.oploverz)) {
            // urlsObj.otakudesu is often in the format: /api/otakudesu/servers?url=https...
            let realOtakuUrl = urlsObj.otakudesu;
            if (realOtakuUrl && realOtakuUrl.startsWith('/api/otakudesu/servers')) {
                realOtakuUrl = new URL('http://localhost' + realOtakuUrl).searchParams.get('url') || realOtakuUrl;
            }

            const [sameRes, otakuRes, kuroRes, oploRes] = await Promise.all([
                urlsObj.samehadaku ? scrapeVideoServers(urlsObj.samehadaku).catch(() => null) : Promise.resolve(null),
                realOtakuUrl ? otakudesu.getServersInternal(realOtakuUrl).catch(() => null) : Promise.resolve(null),
                urlsObj.kuronime ? getKuronimeServers(urlsObj.kuronime).catch(() => null) : Promise.resolve(null),
                urlsObj.oploverz ? getOploverzServers(urlsObj.oploverz).catch(() => null) : Promise.resolve(null)
            ]);
            
            if (kuroRes) {
                data.judul = kuroRes.judul || episodeTitle;
                data.nav_prev = kuroRes.nav_prev;
                data.nav_next = kuroRes.nav_next;
                if (kuroRes.servers) {
                    data.servers = [...data.servers, ...kuroRes.servers.map(s => ({ ...s, source: 'Kuronime' }))];
                }
            }
            if (sameRes) {
                if (!data.judul) data.judul = sameRes.judul || episodeTitle;
                if (!data.nav_prev) data.nav_prev = sameRes.nav_prev;
                if (!data.nav_next) data.nav_next = sameRes.nav_next;
                if (sameRes.servers) {
                    data.servers = [...data.servers, ...sameRes.servers.map(s => ({ ...s, source: 'Samehadaku' }))];
                }
            }
            if (otakuRes) {
                if (!data.judul) data.judul = otakuRes.judul || episodeTitle;
                if (!data.nav_prev) data.nav_prev = otakuRes.nav_prev;
                if (!data.nav_next) data.nav_next = otakuRes.nav_next;
                if (otakuRes.servers) {
                    data.servers = [...data.servers, ...otakuRes.servers.map(s => ({ ...s, source: 'Otakudesu' }))];
                }
            }
            if (oploRes) {
                if (!data.judul) data.judul = oploRes.judul || episodeTitle;
                if (!data.nav_prev) data.nav_prev = oploRes.nav_prev;
                if (!data.nav_next) data.nav_next = oploRes.nav_next;
                if (oploRes.servers) {
                    const mappedOplo = oploRes.servers.map(s => ({
                        nama: s.nama,
                        post: "",
                        nume: s.id || "",
                        type: s.tipe || "direct",
                        aktif: s.aktif,
                        iframeUrl: s.url,
                        namaHost: s.provider || "Direct",
                        source: 'Oploverz'
                    }));
                    data.servers = [...data.servers, ...mappedOplo];
                }
            }
            
            if (!assertAndRespondContract(res, data, 'servers', 'multi-provider')) return;
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
                servers: (neoData.servers || []).map(s => ({ ...s, source: 'Neosatsu' }))
            };
        } else if (targetUrl.includes('kuronime.sbs') || targetUrl.startsWith('/api/kuronime/servers')) {
            let realUrl = targetUrl;
            if (targetUrl.startsWith('/api/kuronime/servers')) {
                realUrl = new URL('http://localhost' + targetUrl).searchParams.get('url') || targetUrl;
            }
            const kuroData = await getKuronimeServers(realUrl);
            data = {
                judul: kuroData.judul || episodeTitle,
                nav_prev: kuroData.nav_prev,
                nav_next: kuroData.nav_next,
                servers: (kuroData.servers || []).map(s => ({ ...s, source: 'Kuronime' }))
            };
        } else if (targetUrl.includes('oploverz.ltd') || targetUrl.startsWith('/api/oploverz/servers')) {
            let realUrl = targetUrl;
            if (targetUrl.startsWith('/api/oploverz/servers')) {
                realUrl = new URL('http://localhost' + targetUrl).searchParams.get('url') || targetUrl;
            }
            const oploData = await getOploverzServers(realUrl);
            data = {
                judul: oploData.judul || episodeTitle,
                nav_prev: oploData.nav_prev,
                nav_next: oploData.nav_next,
                servers: (oploData.servers || []).map(s => ({
                    nama: s.nama,
                    post: "",
                    nume: s.id || "",
                    type: s.tipe || "direct",
                    aktif: s.aktif,
                    iframeUrl: s.url,
                    namaHost: s.provider || "Direct",
                    source: "Oploverz"
                }))
            };
        } else if (!isOtakudesu && targetUrl) {
            data = await scrapeVideoServers(targetUrl);
            if (data && data.servers) {
                data.servers = data.servers.map(s => ({ ...s, source: 'Samehadaku' }));
            }

            // Coba cari alternatif di Otakudesu (Fuzzy Search Fallback)
            if (seriesTitle && episodeTitle) {
                try {
                    if (typeof otakudesu.getAlternativeServers === 'function') {
                        const otakuServers = await otakudesu.getAlternativeServers(seriesTitle, episodeTitle);
                        if (otakuServers && otakuServers.length > 0) {
                            const labeledOtaku = otakuServers.map(s => ({ ...s, source: 'Otakudesu' }));
                            data.servers = [...data.servers, ...labeledOtaku];
                        }
                    }
                } catch (e) {
                    console.warn('[Alternative Otaku Server Fetch Failed]', e.message);
                }
            }
        }
        
        const providerLabel = isOtakudesu ? 'Otakudesu' : (targetUrl.includes('neosatsu') ? 'Neosatsu' : (targetUrl.includes('kuronime') ? 'Kuronime' : (targetUrl.includes('oploverz') ? 'Oploverz' : 'Samehadaku')));
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
