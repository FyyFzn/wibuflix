const express = require('express');
const cors = require('cors');
const { initPagePool } = require('./puppeteer/pool');
const path = require('path');
const { getKatalog, cache } = require('./scraper/katalog');
const { getEpisodes } = require('./scraper/episodes');
const { getHotAnime } = require('./scraper/hot');
const { scrapeVideoServers, resolveSingleServer, extractVideoUrl } = require('./scraper/extractor');
const { getNeosatsuCatalog, getNeosatsuEpisodes, getNeosatsuServers } = require('./scraper/neosatsu');
const otakudesu = require('./scraper/otakudesu_controller');

const app = express();
app.set('trust proxy', true); // Fix: agar req.protocol terbaca 'https' di Azure (di belakang proxy)
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set('json spaces', 2);

// Sajikan file statis (HTML, CSS, JS) dari direktori root proyek
app.use(express.static(path.join(__dirname, '../')));

// ============================================================
// RUTE 1: GET /api/katalog
// ============================================================
app.get('/api/katalog', async (req, res) => {
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

// ============================================================
// RUTE 3: GET /api/scrape?url=URL_EPISODE
// ============================================================
app.get('/api/scrape', async (req, res) => {
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
            headers: data?.headers || undefined,
            webviewOnly: data?.webviewOnly || false
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

// =====================================
// OTAKUDESU ROUTES
// =====================================

app.get('/api/otakudesu/episodes/:slug', otakudesu.getEpisodes);
app.get('/api/otakudesu/servers', otakudesu.getServers);

// =====================================
// FRONTEND ROUTES (React/Vue/Vanilla SPA)
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

// ============================================================
// RUTE 8: GET /api/force-sync  [MANUAL TRIGGER]
// ============================================================
app.get('/api/force-sync', (req, res) => {
    const { syncUnified } = require('./sync/unified_sync');
    const { runSync } = require('./sync/anime_sync');
    
    res.json({ status: 'ok', message: 'Sinkronisasi paksa (Samehadaku & Unified DB) sedang dijalankan di latar belakang. Proses ini memakan waktu beberapa menit.' });
    
    // Jalankan asinkron tanpa memblokir request
    runSync(true).then(() => {
        console.log('[ForceSync] Anime Sync selesai. Memulai Unified Sync...');
        return syncUnified();
    }).catch(err => console.error('[ForceSync] Error:', err.message));
});

const { startBackgroundAnimeSync } = require('./sync/anime_sync');
const { startBackgroundOtakuSync } = require('./scraper/otakudesu_sync');
const { syncUnified } = require('./sync/unified_sync');

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

        // Memulai background job
        startBackgroundAnimeSync();
        startBackgroundOtakuSync();

        // Mulai proses unified sync (akan berjalan sinkron atau asinkron tanpa memblok server)
        setTimeout(() => {
            syncUnified();
            // Jadwalkan sinkronisasi berulang tiap jam
            setInterval(syncUnified, 60 * 60 * 1000);
        }, 10000); // Tunda 10 detik agar localDb & otakuDb selesai di-load

    });
}

module.exports = { startServer };

