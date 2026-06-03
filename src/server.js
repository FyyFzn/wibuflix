const express = require('express');
const cors = require('cors');
const { initPagePool } = require('./puppeteer/pool');
const { getKatalog } = require('./scraper/katalog');
const { getEpisodes } = require('./scraper/episodes');
const { getHotAnime } = require('./scraper/hot');
const { scrapeVideoServers, resolveSingleServer, extractVideoUrl } = require('./scraper/extractor');
const { getWizardEpisodes, getWizardCatalog, getWizardServers } = require('./scraper/wizard');

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
        
        // --- INJEKSI WIZARDSUBS ---
        // Jika tidak ada pencarian, tambahkan item dari WizardSubs ke dalam katalog utama
        if (!searchParam) {
            try {
                const wizardData = await getWizardCatalog(pageParams);
                if (wizardData && wizardData.anime && Array.isArray(wizardData.anime)) {
                    // Konversi struktur WizardSubs agar cocok dengan struktur Samehadaku
                    const wizardList = wizardData.anime.map(w => ({
                        judul: w.title,
                        url: w.endpoint,
                        gambar: w.thumb,
                        gambarScraper: w.thumb,
                        tipe: 'Toku',
                        skor: '-',
                        status: 'WizardSubs'
                    }));
                    // Gabungkan (selipkan di awal atau campur)
                    data.list = [...wizardList, ...(data.list || [])];
                }
            } catch(e) {
                console.error('[Inject Wizard Error]', e.message);
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
app.get('/api/hot', async (req, res) => {
    try {
        const data = await getHotAnime();
        res.json({ status: 'success', data });
    } catch (err) {
        console.error('[Hot Error]', err.message);
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
        let data;
        // Deteksi secara otomatis jika URL mengarah ke WizardSubs
        if (targetUrl.includes('wizardsubs.my.id')) {
            data = await getWizardEpisodes(targetUrl);
        } else {
            data = await getEpisodes(targetUrl);
        }
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
        let data;
        if (targetUrl.includes('wizardsubs.my.id')) {
            const servers = await getWizardServers(targetUrl);
            data = { judul: 'Tokusatsu', nav_prev: null, nav_next: null, servers: servers };
        } else {
            data = await scrapeVideoServers(targetUrl);
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
        
        // Guard: jika semua strategy gagal (misal wibufile/mega/gofile), extractVideoUrl return null
        // Kembalikan webviewOnly: true agar frontend bisa langsung fallback ke WebView
        // JANGAN kirim HTTP 500 karena akan menyebabkan frontend throw exception (res.ok === false)
        if (!data || !data.url) {
            console.log(`[Extract-Video] Ekstraksi gagal/WebView-only: ${embedUrl}`);
            return res.json({ success: false, webviewOnly: true, message: 'Server ini hanya bisa diputar lewat WebView' });
        }
        
        let finalUrl = data.url;
        
        // Gunakan proxy untuk Krakenfiles karena CDN mengunci IP (IP lock)
        if (data?.headers?.token && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(data.url)}&token=${encodeURIComponent(data.headers.token)}&referer=${encodeURIComponent(data.headers.Referer || '')}`;
        } else if ((embedUrl.includes('filedon') || embedUrl.includes('pucuk') || embedUrl.includes('pixeldrain.com')) && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(data.url)}`;
        }
        
        res.json({ 
            success: true, 
            url: finalUrl,
            headers: data?.headers || undefined
        });
    } catch (err) {
        console.error(`[Extractor Error] URL: ${embedUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================================
// RUTE 5B: GET /api/proxy/filedon (SMART HLS PROXY)
// ============================================================
app.get('/api/proxy/filedon', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('URL required');
    
    const https = require('https');
    const http = require('http');
    try {
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.referer;
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        if (videoUrl.includes('filedon') || videoUrl.includes('pucuk')) {
            headers['Referer'] = 'https://filedon.co/';
        }
        
        const client = videoUrl.startsWith('https') ? https : http;
        const proxyReq = client.get(videoUrl, { headers }, (proxyRes) => {
            
            // 1. Tangani Redirect (301/302) agar tidak bypass proxy
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                let redirectUrl = proxyRes.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    redirectUrl = new URL(redirectUrl, videoUrl).href;
                }
                const baseUrl = `${req.protocol}://${req.get('host')}/api/proxy/filedon?url=`;
                res.setHeader('Location', baseUrl + encodeURIComponent(redirectUrl));
                res.status(proxyRes.statusCode).send();
                return;
            }

            if (proxyRes.statusCode >= 400) {
                res.status(proxyRes.statusCode).send('Proxy upstream error');
                return;
            }
            
            const contentType = proxyRes.headers['content-type'] || '';
            const isM3u8 = videoUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u8');

            // 2. Tangani M3U8 Playlist (Tulis ulang semua URL relatif/absolut ke Proxy)
            if (isM3u8) {
                let body = '';
                proxyRes.on('data', chunk => body += chunk);
                proxyRes.on('end', () => {
                    const baseUrl = `${req.protocol}://${req.get('host')}/api/proxy/filedon?url=`;
                    const baseVideoUrl = new URL(videoUrl);
                    
                    const rewritten = body.split('\n').map(line => {
                        const tLine = line.trim();
                        if (tLine && !tLine.startsWith('#')) {
                            let absoluteUri = tLine;
                            if (!tLine.startsWith('http')) {
                                absoluteUri = new URL(tLine, baseVideoUrl.href).href;
                            }
                            return baseUrl + encodeURIComponent(absoluteUri);
                        } else if (tLine.startsWith('#EXT-X-STREAM-INF:') || tLine.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                            if (tLine.includes('URI="')) {
                                return tLine.replace(/URI="([^"]+)"/, (match, uri) => {
                                    let absoluteUri = uri;
                                    if (!uri.startsWith('http')) {
                                        absoluteUri = new URL(uri, baseVideoUrl.href).href;
                                    }
                                    return `URI="${baseUrl}${encodeURIComponent(absoluteUri)}"`;
                                });
                            }
                        }
                        return line;
                    }).join('\n');

                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.status(200).send(rewritten);
                });
            } else {
                // 3. File TS / MP4 langsung di-pipe
                Object.keys(proxyRes.headers).forEach(key => {
                    if (key.toLowerCase() !== 'content-disposition') {
                        res.setHeader(key, proxyRes.headers[key]);
                    }
                });
                
                if (!contentType) {
                    if (videoUrl.includes('.ts')) res.setHeader('Content-Type', 'video/mp2t');
                    else if (videoUrl.includes('.mp4')) res.setHeader('Content-Type', 'video/mp4');
                }
                
                res.status(proxyRes.statusCode);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            console.error('[Filedon Proxy Error]', err.message);
            if (!res.headersSent) res.status(500).send('Proxy error');
        });

        req.on('close', () => {
            proxyReq.destroy();
        });
    } catch (err) {
        console.error('[Filedon Proxy Error]', err.message);
        if (!res.headersSent) res.status(500).send('Proxy error');
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
    
    const https = require('https');
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

        const proxyReq = https.get(videoUrl, { headers }, (proxyRes) => {
            if (proxyRes.statusCode >= 400) {
                res.status(proxyRes.statusCode).send('Proxy upstream error');
                return;
            }
            
            if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
            if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
            if (proxyRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
            if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
            
            res.status(proxyRes.statusCode);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('[Proxy Error]', err.message);
            if (!res.headersSent) res.status(500).send('Proxy error');
        });

        req.on('close', () => {
            proxyReq.destroy();
        });
    } catch (err) {
        console.error('[Proxy Error]', err.message);
        if (!res.headersSent) res.status(500).send('Proxy error');
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
        const log = global.forceLog || console.log;
        
        const modeText = global.forceLog ? `\n💡 Mode         : PRODUCTION (Log standar dinonaktifkan)` : '';
        const banner = `
=============================================
🚀 WIBUFLIX BACKEND SERVER BERHASIL RESTART!
⏰ Waktu Lokal  : ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
📡 Port Aktif   : ${PORT}${modeText}
=============================================
`;
        // Print sebagai satu kesatuan string (Atomic) agar tidak terselip error/log lain di Azure
        log(banner);

        log('⏳ [Puppeteer] Memulai inisialisasi pool browser...');
        await initPagePool();
        log('✅ [Puppeteer] Pool browser berhasil diinisialisasi dan siap digunakan!\n');
    });
}

module.exports = { startServer };

