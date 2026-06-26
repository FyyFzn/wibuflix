import express from 'express';
import https from 'https';
import http from 'http';

const router = express.Router();

// ============================================================
// RUTE 5B: GET /api/proxy/filedon (SMART HLS PROXY)
// ============================================================
router.get('/api/proxy/filedon', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('URL required');
    try {
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.referer;
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        if (videoUrl.includes('filedon') || videoUrl.includes('pucuk')) {
            headers['Referer'] = 'https://filedon.co/';
        } else if (videoUrl.includes('filemoon')) {
            headers['Referer'] = 'https://filemoon.sx/';
        } else if (videoUrl.includes('filelions') || videoUrl.includes('moonplayer')) {
            headers['Referer'] = 'https://filelions.live/';
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

                req.on('close', () => {
                    proxyRes.destroy();
                });
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
router.get('/api/proxy/kraken', async (req, res) => {
    const videoUrl = req.query.url;
    const token = req.query.token;
    const referer = req.query.referer;

    if (!videoUrl) return res.status(400).send('URL required');
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

            req.on('close', () => {
                proxyRes.destroy();
            });
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
// RUTE 7: GET /api/proxy/mega
// ============================================================
router.get('/api/proxy/mega', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('URL required');
    
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [10000, 30000, 60000]; // 10s, 30s, 60s

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { File } = await import('megajs');
            const file = File.fromURL(videoUrl);
            await file.loadAttributes();

            const fileSize = file.size;
            const range = req.headers.range;
            const ext = file.name ? file.name.split('.').pop().toLowerCase() : 'mp4';
            const contentType = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': contentType
                });
                if (req.method !== 'HEAD') {
                    const stream = file.download({ start, end });
                    stream.pipe(res);
                    req.on('close', () => stream.destroy());
                } else {
                    res.end();
                }
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': contentType
                });
                if (req.method !== 'HEAD') {
                    const stream = file.download();
                    stream.pipe(res);
                    req.on('close', () => stream.destroy());
                } else {
                    res.end();
                }
            }
            return; // Berhasil, keluar dari loop retry
        } catch (err) {
            const isEtoomany = err.message && (err.message.includes('ETOOMANY') || err.code === -6 || (err.message.includes('-6')));
            
            if (isEtoomany && attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt];
                console.warn(`[Mega Proxy] ETOOMANY — retry ${attempt + 1}/${MAX_RETRIES} dalam ${delay / 1000} detik...`);
                await new Promise(r => setTimeout(r, delay));
                continue; // Coba lagi
            }

            // Gagal permanen atau error lain
            console.error('[Mega Proxy Error]', err.message);
            if (!res.headersSent) res.status(500).send('Proxy error: ' + err.message);
            return;
        }
    }
});


export default router;
