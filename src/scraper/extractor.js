const { fetchPage, kembalikanKePool, getBrowser, ambilDariPool } = require('../puppeteer/pool');
const cheerio = require('cheerio');

function extractIframeSrc(html) {
    const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : null;
}

function namaServer(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        if (host.includes('wibufile')) return 'wibufile';
        if (host.includes('kraken')) return 'krakenfiles';
        if (host.includes('mega.nz')) return 'mega';
        if (host.includes('bili')) return 'bilibili';
        if (host.includes('blog')) return 'blogger';
        if (host.includes('mp4upload')) return 'mp4upload';
        if (host.includes('gdrive') || host.includes('google')) return 'gdrive';
        if (host.includes('vidhide')) return 'vidhide';
        
        return host.replace('www.', '').split('.')[0];
    } catch {
        return '';
    }
}

// ── Blogger / Google Video extractor ────────────────────────
// blogger.com/video.g?token=... → redirector.googlevideo.com/...
async function extractBloggerVideo(embedUrl, browser, req) {
    console.log(`[Blogger] Extracting: ${embedUrl}`);
    let page;
    try {
        page = await browser.newPage();
        if (req) {
            req.on('close', () => {
                if (page && !page.isClosed()) page.close().catch(()=>{});
            });
        }
        await page.setRequestInterception(true);

        let videoUrl = null;

        page.on('request', req => {
            const url = req.url();
            // Tangkap redirect ke googlevideo / videoplayback
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                videoUrl = url;
                req.abort();
            } else {
                req.continue();
            }
        });

        page.on('response', async res => {
            if (videoUrl) return;
            const url = res.url();
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                videoUrl = url;
            }
        });

        // Navigasi ke embed blogger
        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

        // Tunggu sampai video element muncul, lalu ambil src-nya
        const srcFromDom = await page.evaluate(() => {
            const v = document.querySelector('video source, video');
            return v ? (v.src || v.getAttribute('src') || '') : '';
        }).catch(() => '');

        if (srcFromDom && srcFromDom.startsWith('http')) {
            videoUrl = srcFromDom;
        }

        // Klik play untuk trigger network request jika belum dapat URL
        if (!videoUrl) {
            await page.evaluate(() => {
                const playBtn = document.querySelector('.ytp-large-play-button, .play-button, button');
                if (playBtn) playBtn.click();
                const v = document.querySelector('video');
                if (v) v.play().catch(() => {});
            }).catch(() => {});

            // Fallback click center
            try {
                const viewport = page.viewport() || { width: 800, height: 600 };
                await page.mouse.click(viewport.width / 2, viewport.height / 2);
            } catch (e) {}

            // Tunggu maks 8 detik
            await new Promise(resolve => {
                const t = setTimeout(() => resolve(), 8000);
                const check = setInterval(() => {
                    if (videoUrl) { clearInterval(check); clearTimeout(t); resolve(); }
                }, 300);
            });
        }

        await page.close().catch(() => {});
        return videoUrl || null;
    } catch (err) {
        console.error('[Blogger] Error:', err.message);
        if (page) await page.close().catch(() => {});
        return null;
    }
}

async function extractKrakenVideo(embedUrl, req) {
    console.log(`[Kraken] Extracting: ${embedUrl}`);
    const axios = require('axios');
    const cheerio = require('cheerio');
    
    const controller = new AbortController();
    if (req) req.on('close', () => controller.abort());

    try {
        let viewUrl = embedUrl;
        if (embedUrl.includes('/embed-video/')) {
            viewUrl = embedUrl.replace('/embed-video/', '/view/') + '/file.html';
        }
        
        const { data } = await axios.get(viewUrl, {
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": viewUrl,
                "Accept": "*/*"
            }
        });
        
        const $ = cheerio.load(data);
        const token = $("#dl-token").val();
        
        let src;
        if ($("video").html()) {
            src = $("video source").attr("src");
        } else {
            src = $(".lightgallery a").attr("href");
        }
        
        if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            
            return {
                success: true,
                url: src,
                headers: token ? { 
                    'token': token,
                    'Referer': viewUrl
                } : {
                    'Referer': viewUrl
                }
            };
        }
        
        return null;
    } catch (err) {
        console.error('[Kraken] Error:', err.message);
        return null;
    }
}

async function resolveServerIframe(page, { post, nume, type, episodeUrl }, req) {
    try {
        const result = await page.evaluate(async ({ post, nume, type, episodeUrl }) => {
            try {
                const response = await fetch('https://v2.samehadaku.how/wp-admin/admin-ajax.php', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': '*/*',
                        'Referer': episodeUrl,
                        'Origin': 'https://v2.samehadaku.how'
                    },
                    credentials: 'include',
                    body: `action=player_ajax&post=${post}&nume=${nume}&type=${type}`
                });

                const text = await response.text();
                return { ok: response.ok, status: response.status, text };
            } catch (e) {
                return { ok: false, status: 0, text: '', error: e.message };
            }
        }, { post, nume, type, episodeUrl });

        console.log(`    AJAX [post=${post} nume=${nume}] status=${result.status} len=${result.text.length}`);

        if (!result.ok || !result.text) return null;

        try {
            const json = JSON.parse(result.text);
            const html = json.data || json.embed_url || json.embed || json.url || result.text;
            const url = extractIframeSrc(String(html));
            if (url) return url;
            
            if (typeof json.url === 'string' && (json.url.startsWith('http') || json.url.startsWith('//'))) {
                return json.url;
            }
            if (typeof html === 'string' && (html.startsWith('http') || html.startsWith('//'))) {
                return html;
            }
        } catch {
            const url = extractIframeSrc(result.text);
            if (url) return url;
        }

        const urlMatch = result.text.match(/(https?:\/\/[^\s"'<>]+)/) || result.text.match(/(\/\/[^\s"'<>]+)/);
        if (urlMatch) return urlMatch[1];

        const vidlionMatch = result.text.match(/\[vidlion id=([^\]]+)\]/i);
        if (vidlionMatch) return `https://vidhidepro.com/v/${vidlionMatch[1]}`;

        console.log(`    [Resolve Failed] Raw text: ${result.text.substring(0, 100)}`);
        return null;
    } catch (err) {
        console.error(`    AJAX Error:`, err.message);
        return null;
    }
}

async function scrapeVideoServers(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Scrape Fast] ${targetUrl}`);

    let slot;
    try {
        slot = await ambilDariPool();
        const page = slot.page;

        // Fetch HTML text directly via Puppeteer's fetch to bypass CF quickly
        const html = await page.evaluate(async (url) => {
            const res = await fetch(url);
            return await res.text();
        }, targetUrl);

        const $ = cheerio.load(html);

        const judul = ($('h1[itemprop="name"]').text() || $('h1.entry-title').text() || $('title').text().replace(/[-–|].*$/, '')).trim();

        let nav_prev = null, nav_next = null;
        $('a[data-wpel-link="internal"]').each((_, el) => {
            const cls = $(el).find('i').attr('class') || '';
            if (cls.includes('chevron-left')) nav_prev = $(el).attr('href');
            if (cls.includes('chevron-right')) nav_next = $(el).attr('href');
        });

        const rawServers = [];
        $('.east_player_option').each((_, el) => {
            rawServers.push({
                nama: $(el).find('span').text().trim() || $(el).text().trim() || 'Server',
                post: $(el).attr('data-post') || '',
                nume: $(el).attr('data-nume') || '',
                type: $(el).attr('data-type') || 'schtml',
                aktif: $(el).hasClass('on')
            });
        });

        const seen = new Set();
        const servers = [];
        for (const s of rawServers) {
            const key = `${s.post}-${s.nume}`;
            if (!seen.has(key)) {
                seen.add(key);
                servers.push(s);
            }
        }

        const BLACKLIST = ['facebook', 'dtscout', 'crwdcntrl', 'doubleclick', 'googlesyndication'];
        let iframeAktif = null;
        $('iframe').each((_, el) => {
            const src = $(el).attr('src');
            if (src && src.startsWith('http') && !BLACKLIST.some(b => src.includes(b))) {
                iframeAktif = src;
                return false; // break loop
            }
        });

        const gambar = $('meta[property="og:image"]').attr('content') ||
                       $('.thumbook img').attr('src') ||
                       $('.thumb img').attr('src') ||
                       $('img[itemprop="image"]').attr('src') || '';

        console.log(`  Judul  : ${judul}`);
        console.log(`  Server : ${servers.length} ditemukan`);

        const activeServer = servers.find(srv => srv.aktif);
        if (activeServer && iframeAktif) {
            activeServer.iframeUrl = iframeAktif;
            activeServer.namaHost = namaServer(iframeAktif);
        }

        return { judul, gambar, nav_prev, nav_next, servers, iframeAktif };
    } catch (err) {
        throw err;
    } finally {
        if (slot) kembalikanKePool(slot);
    }
}

async function resolveSingleServer(targetUrl, nume, req) {
    if (!targetUrl || !nume) throw new Error("Parameter 'url' dan 'nume' wajib diisi!");
    console.log(`\n[Resolve Fast] ${targetUrl} [nume=${nume}]`);

    let slot;
    try {
        slot = await ambilDariPool();
        const page = slot.page;

        // Fast fetch to get the post ID
        const html = await page.evaluate(async (url) => {
            const res = await fetch(url);
            return await res.text();
        }, targetUrl);

        const $ = cheerio.load(html);
        const post = $('.east_player_option').first().attr('data-post') || '';

        if (!post) throw new Error("Tidak menemukan ID Post (data-post)");

        const iframeUrl = await resolveServerIframe(page, {
            post,
            nume,
            type: 'schtml',
            episodeUrl: targetUrl
        }, req);

        if (!iframeUrl) throw new Error("Gagal mengekstrak iframe URL dari AJAX");

        return { iframeUrl, namaHost: namaServer(iframeUrl) };
    } catch (err) {
        throw err;
    } finally {
        if (slot) kembalikanKePool(slot);
    }
}

async function extractVideoUrl(embedUrl, req) {
    if (!embedUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Extract] ${embedUrl}`);

    const browser = await getBrowser();

    // ── Bypass untuk link langsung (seperti Wibufile .mp4) ──
    if (embedUrl.match(/\.(mp4|mkv|m3u8)(?:\?|$)/i) || embedUrl.includes('wibufile.com')) {
        console.log(`[Direct] URL sudah merupakan file video langsung: ${embedUrl}`);
        return { 
            url: embedUrl,
            headers: {
                'Referer': 'https://v2.samehadaku.how/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };
    }

    // ── Handler khusus Blogger / Google Video ────────────────
    if (embedUrl.includes('blogger.com/video') || embedUrl.includes('blogger.com/video.g')) {
        const videoUrl = await extractBloggerVideo(embedUrl, browser, req);
        if (videoUrl) return { url: videoUrl };
        throw new Error('Gagal mengekstrak video dari Blogger');
    }

    if (embedUrl.includes('krakenfiles.com')) {
        const result = await extractKrakenVideo(embedUrl, req);
        if (result && result.url) {
            return {
                url: result.url,
                headers: result.headers || {}
            };
        }
        if (result && typeof result === 'string') {
            return { url: result };
        }
        throw new Error('Gagal mengekstrak video dari Krakenfiles');
    }

    // ── Handler Vidhide (Axios Fast Extractor) ────────────────
    if (embedUrl.includes('vidhide') || embedUrl.includes('vidlion')) {
        const axios = require('axios');
        const vm = require('vm');
        try {
            console.log(`[Vidhide] Extracting (Axios): ${embedUrl}`);
            const { data } = await axios.get(embedUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Referer": "https://v2.samehadaku.how/"
                }
            });

            let htmlSource = data;
            const packRegex = /eval\((function\(p,a,c,k,e,?[d]?\)[\s\S]*?\.split\('\|'\).*?\))\)/;
            const packerMatch = data.match(packRegex);
            
            if (packerMatch) {
                try {
                    const unpacked = vm.runInNewContext(`(${packerMatch[1]})`, {});
                    htmlSource += "\n" + unpacked;
                } catch (e) {
                    console.log('[Vidhide] Unpack error:', e.message);
                }
            }
            
            const m3Match = htmlSource.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8)[^\s"'<>]*)/i) || 
                            htmlSource.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
            
            if (m3Match && m3Match[1]) {
                const vidhideUrl = m3Match[1].replace(/\\/g, '');
                console.log(`[Vidhide] Found direct URL!`);
                return {
                    url: vidhideUrl,
                    headers: { 
                        'Referer': embedUrl,
                        'Origin': 'https://vidhidepro.com'
                    }
                };
            }
        } catch (e) {
            console.log(`[Vidhide] Axios failed: ${e.message}, falling back to Puppeteer`);
        }
    }

    // ──────────────── General extractor (iframe embed) ────────────────
    let tempPage;
    try {
        tempPage = await browser.newPage();
        if (req) {
            req.on('close', () => {
                if (tempPage && !tempPage.isClosed()) tempPage.close().catch(()=>{});
            });
        }
        await tempPage.setExtraHTTPHeaders({
            'Referer': 'https://v2.samehadaku.how/',
            'Origin': 'https://v2.samehadaku.how'
        });
        await tempPage.setRequestInterception(true);
        
        let videoUrl = null;

        tempPage.on('request', (request) => {
            const rt = request.resourceType();
            const reqUrl = request.url();
            
            if (reqUrl === 'https://v2.samehadaku.how/' && rt === 'document') {
                return request.respond({
                    status: 200,
                    contentType: 'text/html',
                    body: '<html style="height:100%;"><body style="height:100%; margin:0; background:#000;"></body></html>'
                });
            }

            if (rt === 'media' || reqUrl.includes('.mp4') || reqUrl.includes('.m3u8') || reqUrl.includes('.mkv')) {
                videoUrl = reqUrl;
                return request.abort(); 
            } else {
                return request.continue();
            }
        });

        tempPage.on('response', async (response) => {
            if (videoUrl) return;
            const url = response.url();
            const type = response.headers()['content-type'] || '';
            const status = response.status();
            
            try {
                const urlObj = new URL(embedUrl);
                if (url.includes(urlObj.pathname) && status >= 400) {
                    videoUrl = 'ERROR';
                    return;
                }
            } catch(e) {}

            if (
                url.includes('.m3u8') || url.includes('.mp4') || 
                type.includes('video') || type.includes('mpegurl') || type.includes('octet-stream')
            ) {
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
        });

        const extractPromise = new Promise(resolve => {
            const checkInterval = setInterval(async () => {
                if (videoUrl) {
                    clearInterval(checkInterval);
                    return resolve(videoUrl);
                }
                try {
                    for (const f of tempPage.frames()) {
                        const html = await f.content().catch(() => '');
                        const match = html.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i);
                        if (match && match[1] && !match[1].includes('google')) {
                            videoUrl = match[1];
                            clearInterval(checkInterval);
                            return resolve(videoUrl);
                        }
                    }
                } catch (e) {}
            }, 500);
            setTimeout(() => { 
                clearInterval(checkInterval); 
                resolve(null); 
            }, 8000); // reduced from 15s to 8s
        });

        await tempPage.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(e => {});
        await tempPage.evaluate((url) => {
            const iframe = document.createElement('iframe');
            iframe.src = url;
            iframe.style.width = '100%';
            iframe.style.height = '100%';
            iframe.setAttribute('allow', 'autoplay; fullscreen');
            document.body.appendChild(iframe);
        }, embedUrl);

        setTimeout(async () => {
            try {
                const viewport = tempPage.viewport() || { width: 800, height: 600 };
                // Fast triple click to bypass popup ads and trigger play
                await tempPage.mouse.click(viewport.width / 2, viewport.height / 2);
                await new Promise(r => setTimeout(r, 200));
                await tempPage.mouse.click(viewport.width / 2, viewport.height / 2);
                await new Promise(r => setTimeout(r, 200));
                await tempPage.mouse.click(viewport.width / 2, viewport.height / 2);
            } catch (e) {}
        }, 500); // reduced from 2s to 500ms

        const finalUrl = await extractPromise;
        await tempPage.close().catch(() => {});

        if (finalUrl && finalUrl !== 'ERROR') {
            return { url: finalUrl };
        } else {
            throw new Error('Gagal mengekstrak video atau server down (404)');
        }
    } catch (error) {
        if (tempPage) await tempPage.close().catch(e => {});
        throw error;
    }
}

module.exports = { scrapeVideoServers, resolveSingleServer, extractVideoUrl };
