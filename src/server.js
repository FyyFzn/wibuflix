const express = require('express');
const cors = require('cors');
const { initPagePool } = require('./puppeteer/pool');
const { getKatalog } = require('./scraper/katalog');
const { getEpisodes } = require('./scraper/episodes');
const { scrapeVideoServers, resolveSingleServer, extractVideoUrl } = require('./scraper/extractor');

const app = express();
app.set('trust proxy', true); // Fix: agar req.protocol terbaca 'https' di Azure (di belakang proxy)
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set('json spaces', 2);

// Sajikan file statis (HTML, CSS, JS) dari direktori root proyek
const path = require('path');
app.use(express.static(path.join(__dirname, '../')));

// ============================================================
// RUTE 1: GET /api/katalog?page=N&s=KEYWORD
// ============================================================
app.get('/api/katalog', async (req, res) => {
    const pageParams = req.query.page || 1;
    const searchParam = req.query.s || '';

    try {
        const data = await getKatalog(pageParams, searchParam);
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Katalog Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================
// RUTE 2: GET /api/episodes?url=URL_ANIME
// ============================================================
app.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Parameter 'url' wajib diisi!" });

    try {
        const data = await getEpisodes(targetUrl);
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Episodes Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================
// RUTE 3: GET /api/scrape?url=URL_EPISODE
// ============================================================
app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Parameter 'url' wajib diisi!" });

    try {
        const data = await scrapeVideoServers(targetUrl);
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Scrape Error]', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================
// RUTE 4: GET /api/resolve?url=URL_EPISODE&nume=NUME_ID
// ============================================================
app.get('/api/resolve', async (req, res) => {
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

// ============================================================
// RUTE 5: GET /api/extract-video?url=EMBED_URL
// ============================================================
app.get('/api/extract-video', async (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).json({ success: false, error: "Parameter 'url' wajib diisi!" });

    try {
        const data = await extractVideoUrl(embedUrl, req);
        let finalUrl = data.url;
        
        // Disable proxy untuk Krakenfiles agar langsung dari CDN (mengatasi buffering parah)
        // if (data.headers && data.headers.token && data.url) {
        //     const baseUrl = `${req.protocol}://${req.get('host')}`;
        //     finalUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(data.url)}&token=${encodeURIComponent(data.headers.token)}&referer=${encodeURIComponent(data.headers.Referer || '')}`;
        // }
        
        res.json({ 
            success: true, 
            url: finalUrl,
            headers: data.headers || undefined
        });
    } catch (err) {
        console.error('[Extractor Error]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================================
// RUTE 6: GET /api/proxy/kraken
// ============================================================
app.get('/api/proxy/kraken', async (req, res) => {
    const videoUrl = req.query.url;
    const token = req.query.token;
    const referer = req.query.referer;
    
    if (!videoUrl) return res.status(400).send('URL required');
    
    const axios = require('axios');
    try {
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": referer || 'https://krakenfiles.com/',
            "Accept": "*/*",
            "token": token || ''
        };
        
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            headers: headers,
            validateStatus: status => status >= 200 && status < 400
        });
        
        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        if (response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
        if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        
        res.status(response.status);
        response.data.pipe(res);
    } catch (err) {
        console.error('[Proxy Error]', err.message);
        res.status(500).send('Proxy error');
    }
});

// ============================================================
// RUTE 7: GET /api/cache-clear  [DEV only]
// ============================================================
app.get('/api/cache-clear', (req, res) => {
    const { cache: katalogCache } = require('./scraper/katalog');
    const { cache: epsCache } = require('./scraper/episodes');
    if (katalogCache) katalogCache.flushAll();
    if (epsCache) epsCache.flushAll();
    res.json({ status: 'ok', message: 'Cache cleared' });
});

function startServer() {
    app.listen(PORT, '0.0.0.0', async () => {
        console.log(`Server WibuFlix jalan di http://0.0.0.0:${PORT}`);
        await initPagePool();
    });
}

module.exports = { startServer };

