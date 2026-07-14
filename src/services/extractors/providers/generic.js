import axios from 'axios';
import { acquireFromExtractorPool, releaseToPool, getBrowser } from '../../../puppeteer/pool.js';
import { PROVIDER_URLS } from '../../../config/providerUrls.js';

export const name = 'generic';

export function match(url) {
    return true; // Fallback
}

export async function extract(embedUrl, req) {
    // ── 1. Fast Generic HTML Parse (Untuk Nakama, Kuro, dll) ──
    try {
        console.log(`[Fast Generic] Mencoba ekstrak langsung dari HTML: ${embedUrl}`);
        const { data } = await axios.get(embedUrl, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`
            }
        });
        
        const m3Match = data.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i) || 
                        data.match(/file:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                        data.match(/source:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
                        
        if (m3Match && m3Match[1] && !m3Match[1].includes('google')) {
            let fastUrl = m3Match[1].replace(/\\/g, '').replace(/&amp;/g, '&');
            console.log(`[Fast Generic] Ditemukan URL langsung!`);
            return { url: fastUrl };
        }
        console.log(`[Fast Generic] Tidak ditemukan URL langsung, lanjut ke Puppeteer...`);
    } catch (e) {
        console.log(`[Fast Generic] Gagal/Terblokir: ${e.message}, lanjut ke Puppeteer...`);
    }

    // ── 2. Puppeteer Extraction ──
    let slot;
    let tempPage;
    let isTempSpaPage = false;
    let clickInterval;
    let checkInterval;
    let timeoutId;
    let videoUrl = null;
    let responseHandler = null;
    try {
        const isSPA = embedUrl.includes('filedon') || embedUrl.includes('filemoon') || embedUrl.includes('filelions') || embedUrl.includes('moonplayer') || embedUrl.includes('pucukmovie') || embedUrl.includes('pucuk');

        if (isSPA) {
            const browser = await getBrowser();
            tempPage = await browser.newPage();
            isTempSpaPage = true;
            await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        } else {
            slot = await acquireFromExtractorPool();
            tempPage = slot.page;
            await tempPage.setExtraHTTPHeaders({
                'Referer': `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/`,
                'Origin': `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}`
            });
        }

        responseHandler = async (response) => {
            if (videoUrl) return;
            const url = response.url();
            const type = (response.headers()['content-type'] || '').toLowerCase();
            
            if (url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|wasm|json|webmanifest|manifest|txt|xml)([?#].*)?$/i)) {
                return;
            }

            if (url.includes('filedon') || url.includes('wibufile')) console.log(`[Ext-Network] URL: ${url} | Type: ${type}`);

            if (
                url.includes('.m3u8') || url.includes('.mp4') || 
                type.includes('video') || type.includes('mpegurl') || 
                (type.includes('octet-stream') && (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.ts') || url.includes('/hls/')))
            ) {
                console.log(`[Ext-Network] FOUND VIDEO URL: ${url}`);
                videoUrl = url;
                return;
            }

            if ((type.includes('json') || type.includes('text')) && !url.includes('google')) {
                try {
                    const text = await response.text();
                    const match = text.match(/(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*)/i);
                    if (match && match[1]) {
                        videoUrl = match[1].replace(/\\/g, '');
                    }
                } catch (e) {}
            }
        };
        tempPage.on('response', responseHandler);

        // Eksekusi satu kali injeksi auto-play JS yang pasif namun efektif
        await tempPage.evaluateOnNewDocument(() => {
            window.addEventListener('DOMContentLoaded', () => {
                setInterval(() => {
                    document.querySelectorAll('video').forEach(v => {
                        if (v.paused) v.play().catch(() => {});
                    });
                }, 2000);
            });
        }).catch(() => {});

        const extractPromise = new Promise(resolve => {
            let elapsed = 0;
            const checkStep = 1000; // Polling 1 detik (mengurangi 50% beban IPC)

            let isPolling = false;
            checkInterval = setInterval(async () => {
                if (isPolling || tempPage.isClosed()) return;
                isPolling = true;
                try {
                    elapsed += checkStep;
                    if (videoUrl) {
                        clearInterval(checkInterval);
                        if (timeoutId) clearTimeout(timeoutId);
                        return resolve(videoUrl);
                    }

                    // Klik berkala dengan frekuensi lebih rendah (tiap 3 detik, bukan 1.5s)
                    if (elapsed % 3000 === 0 && !tempPage.isClosed()) {
                        try {
                            const viewport = tempPage.viewport() || { width: 800, height: 600 };
                            await tempPage.mouse.click(viewport.width / 2, viewport.height / 2).catch(() => {});
                            await tempPage.evaluate(() => {
                                const btn = document.querySelector('.play-btn, [class*="play"], button, [role="button"]');
                                if (btn) btn.click();
                            }).catch(() => {});
                        } catch (e) {}
                    }

                    // Cek frame tiap 2 detik
                    if (elapsed % 2000 === 0 && !tempPage.isClosed()) {
                        try {
                            for (const f of tempPage.frames()) {
                                const html = await Promise.race([f.content().catch(() => ''), new Promise(r => setTimeout(() => r(''), 1000))]);
                                const match = html.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i);
                                if (match && match[1] && !match[1].includes('google')) {
                                    videoUrl = match[1];
                                    clearInterval(checkInterval);
                                    if (timeoutId) clearTimeout(timeoutId);
                                    return resolve(videoUrl);
                                }
                            }
                        } catch (e) {}
                    }
                } finally {
                    isPolling = false;
                }
            }, checkStep);

            timeoutId = setTimeout(() => { 
                clearInterval(checkInterval); 
                resolve(null); 
            }, 25000);
        });

        if (isSPA) {
            await tempPage.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {});
        } else {
            await tempPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(e => {});
            await tempPage.setContent('<html style="height:100%;"><body style="height:100%; margin:0; background:#000;"></body></html>');
            await tempPage.evaluate((url) => {
                const iframe = document.createElement('iframe');
                iframe.src = url;
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                iframe.setAttribute('allow', 'autoplay; fullscreen');
                document.body.appendChild(iframe);
            }, embedUrl);
        }

        const finalUrl = await extractPromise;
        
        if (finalUrl && finalUrl !== 'ERROR') {
            const cleanUrl = finalUrl.replace(/&amp;/g, '&');
            return { url: cleanUrl };
        }
        return null;
    } catch (error) {
        console.error('[Extractor] Error:', error.message);
        return null;
    } finally {
        try { if (clickInterval) clearInterval(clickInterval); } catch (e) {}
        try { if (checkInterval) clearInterval(checkInterval); } catch (e) {}
        try { if (timeoutId) clearTimeout(timeoutId); } catch (e) {}
        if (tempPage && responseHandler) {
            try { tempPage.off('response', responseHandler); } catch (e) {}
        }
        if (isTempSpaPage && tempPage) {
            tempPage.close().catch(() => {});
        } else if (slot) {
            releaseToPool(slot);
        }
    }
}
