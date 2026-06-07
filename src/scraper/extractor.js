const { fetchPage, kembalikanKePool, getBrowser, ambilDariPool, ambilDariExtractorPool } = require('../puppeteer/pool');
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
        if (host.includes('filemoon') || host.includes('filelions') || host.includes('moonplayer') || host.includes('filedon')) return 'pucuk';
        
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

        page.on('request', request => {
            const rt = request.resourceType();
            const url = request.url();
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                videoUrl = url;
                return request.abort();
            }
            if (['image', 'font', 'stylesheet'].includes(rt)) {
                return request.abort();
            }
            request.continue();
        });

        page.on('response', async res => {
            if (videoUrl) return;
            const url = res.url();
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                videoUrl = url;
            }
        });

        const extractPromise = new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (videoUrl) {
                    clearInterval(checkInterval);
                    return resolve(videoUrl);
                }
            }, 100);
            setTimeout(() => { 
                clearInterval(checkInterval); 
                resolve(null); 
            }, 6000);
        });

        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {});

        if (!videoUrl) {
            await page.evaluate(() => {
                const playBtn = document.querySelector('.ppVepb, .iLXc1d, .ytp-large-play-button, .play-button, button, [role="button"]');
                if (playBtn) playBtn.click();
                const v = document.querySelector('video');
                if (v) v.play().catch(() => {});
            }).catch(() => {});

            try {
                const viewport = page.viewport() || { width: 800, height: 600 };
                await page.mouse.click(viewport.width / 2, viewport.height / 2);
                await new Promise(r => setTimeout(r, 200));
                await page.mouse.click(viewport.width / 2, viewport.height / 2);
            } catch (e) {}
        }

        const finalUrl = await extractPromise;
        return finalUrl || null;
    } catch (err) {
        console.error('[Blogger] Error:', err.message);
        return null;
    } finally {
        if (page && !page.isClosed()) await page.close().catch(() => {});
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
        if ($("video source").length > 0) {
            src = $("video source").attr("src");
        } else if ($("video").attr("src")) {
            src = $("video").attr("src");
        } else if ($(".lightgallery a").length > 0) {
            src = $(".lightgallery a").attr("href");
        } else if ($("a[data-type='video']").length > 0) {
            src = $("a[data-type='video']").attr("href");
        } else {
            // Regex match as last resort
            const m = data.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv))/i);
            if (m) src = m[1];
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
        let html = await page.evaluate(async (url) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                return await res.text();
            } catch(e) {
                return '';
            }
        }, targetUrl);

        if (!html || html.trim() === '' || html.includes('cf-browser-verification') || html.includes('Just a moment')) {
            console.log(`[Scrape] Fetch gagal/terblokir Cloudflare. Fallback ke page.goto...`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            html = await page.content();
        }

        const $ = cheerio.load(html);

        const judul = ($('h1[itemprop="name"]').text() || $('h1.entry-title').text() || $('title').text().replace(/[-–|].*$/, '')).trim();

        let nav_prev = null, nav_next = null;
        $('a[data-wpel-link="internal"]').each((_, el) => {
            const cls = $(el).find('i').attr('class') || '';
            if (cls.includes('chevron-left')) nav_prev = $(el).attr('href');
            if (cls.includes('chevron-right')) nav_next = $(el).attr('href');
        });

        const servers = [];
        
        // --- NEW LOGIC: Ekstrak link download untuk Resolusi Eksplisit ---
        $('*[class*="download"]').each((_, el) => {
            const block = $(el);
            let formatDesc = block.find('p b').text().trim() || 'MP4';
            if (formatDesc.toLowerCase().includes('batch')) return; // skip batch
            if (formatDesc.toLowerCase().includes('mkv')) formatDesc = 'MKV';
            else if (formatDesc.toLowerCase().includes('mp4')) formatDesc = 'MP4';
            else if (formatDesc.toLowerCase().includes('x265')) formatDesc = 'x265';
            
            block.find('ul li').each((_, li) => {
                const res = $(li).find('strong').text().trim().replace(' ', ''); // e.g. "360p"
                if (res.toLowerCase().includes('batch')) return; // Skip batch resolution

                $(li).find('span a').each((_, a) => {
                    const hostNameRaw = $(a).text().trim();
                    const hostNameLower = hostNameRaw.toLowerCase();
                    if (hostNameLower.includes('batch')) return; // Skip batch host name

                    const href = $(a).attr('href');
                    
                    const allowedHosts = ['kraken', 'pucuk', 'pixeldrain', 'wibufile', 'vidhide', 'filedon', 'filemoon', 'filelions', 'gofile', 'acefile', 'mirrorupload', 'mega'];
                    const isAllowed = allowedHosts.some(h => hostNameLower.includes(h));
                    
                    // Kita ambil hoster prioritas
                    if (href && isAllowed) {
                        // Normalisasi URL: konversi download page (/f/) ke embed URL (/e/)
                        // agar extractor bisa bekerja (wibufile/filemoon/filelions)
                        // Catatan: Filedon/Pucuk tidak butuh ini karena /f/ mereka adalah SPA Inertia valid
                        let normalizedHref = href;
                        const isEmbedHost = ['filemoon', 'filelions', 'moonplayer', 'wibufile'].some(h => hostNameLower.includes(h));
                        if (isEmbedHost && normalizedHref.match(/\/f\/[^/]+\/?$/)) {
                            normalizedHref = normalizedHref.replace(/\/f\//, '/e/');
                            console.log(`[Scrape] Konversi ke embed URL: ${normalizedHref}`);
                        }
                        servers.push({
                            nama: `${res} ${formatDesc}`.trim(),
                            post: "",
                            nume: "",
                            type: "direct",
                            aktif: servers.length === 0, // Jadikan yang pertama aktif
                            iframeUrl: normalizedHref,
                            namaHost: hostNameRaw
                        });
                    }
                });
            });
        });

        // Jika tidak ada link download (episode lama), gunakan cara lama (side-by-side dimatikan jika download ada)
        if (servers.length === 0) {
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
            for (const s of rawServers) {
                const key = `${s.post}-${s.nume}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    servers.push(s);
                }
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
        let html = await page.evaluate(async (url) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                return await res.text();
            } catch(e) {
                return '';
            }
        }, targetUrl);

        let $ = cheerio.load(html);
        let post = $('.east_player_option').first().attr('data-post') || '';

        // Fallback to Puppeteer page.goto if fetch failed (Cloudflare IUAM / Tarpit)
        if (!post) {
            console.log(`[Resolve] Fetch gagal/terblokir Cloudflare. Fallback ke page.goto...`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            html = await page.content();
            $ = cheerio.load(html);
            post = $('.east_player_option').first().attr('data-post') || '';
        }

        if (!post) throw new Error("Tidak menemukan ID Post (data-post) setelah fallback");

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

    // ── 1. Bypass Mutlak untuk link yang sudah berupa file video langsung ──
    if (embedUrl.match(/\.(mp4|mkv|m3u8)(?:\?|$)/i)) {
        console.log(`[Direct] URL sudah merupakan file video langsung: ${embedUrl}`);
        return { 
            url: embedUrl,
            headers: {
                'Referer': 'https://v2.samehadaku.how/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };
    }

    // ── 2. Bypass Cepat untuk Server WebView-Only (Mencegah Timeout 25 Detik) ──
    const webviewOnlyHosts = ['mega.nz', 'mirrorupload', 'gofile'];
    if (webviewOnlyHosts.some(h => embedUrl.toLowerCase().includes(h))) {
        console.log(`[WebView-Only] Melewati ekstraksi Puppeteer untuk: ${embedUrl}`);
        return null; // Akan langsung memicu fallback WebView di frontend secara instan
    }

    const browser = await getBrowser();

    // ── Handler API Pixeldrain (Ekstraksi Instan Tanpa Puppeteer) ──
    if (embedUrl.includes('pixeldrain.com/u/')) {
        const idMatch = embedUrl.match(/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/);
        if (idMatch && idMatch[1]) {
            const directUrl = `https://pixeldrain.com/api/file/${idMatch[1]}`;
            console.log(`[Pixeldrain] Fast API URL: ${directUrl}`);
            return {
                url: directUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                }
            };
        }
    }

    // ── Handler Acefile (Fast Extractor) ────────────────
    if (embedUrl.includes('acefile')) {
        const axios = require('axios');
        try {
            console.log(`[Acefile] Mengekstrak: ${embedUrl}`);
            const { data: html } = await axios.get(embedUrl, {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            
            const evalRegex = /eval\(function\(p,a,c,k,e,d\).*?\)\)/s;
            const match = html.match(evalRegex);
            if (match) {
                let evalCode = match[0];
                let unpacked = '';
                evalCode = evalCode.replace(/^eval/, 'unpacked = ');
                eval(evalCode);
                
                const mirrorMatch = unpacked.match(/\[\{"v":".*?\}\]/);
                if (mirrorMatch) {
                    const mirrorArr = JSON.parse(mirrorMatch[0]);
                    console.log(`[Acefile] Ditemukan ${mirrorArr.length} mirror`);
                    
                    for (const m of mirrorArr) {
                        const localUrl = \`https://acefile.co/local/\${m.v}?key=\${m.J}\`;
                        try {
                            const { data: localHtml } = await axios.get(localUrl, {
                                timeout: 10000,
                                headers: { 'User-Agent': 'Mozilla/5.0' }
                            });
                            
                            const sourceMatch = localHtml.match(/sources:\s*JSON\.parse\(atob\("([^"]+)"\)\)/);
                            if (sourceMatch) {
                                const decoded = Buffer.from(sourceMatch[1], 'base64').toString('utf8');
                                const sources = JSON.parse(decoded);
                                if (sources.length > 0) {
                                    const serviceUrl = 'https://acefile.co' + sources[0].file;
                                    console.log(\`[Acefile] Menelusuri redirect: \${serviceUrl}\`);
                                    
                                    const redirectRes = await axios.get(serviceUrl, {
                                        maxRedirects: 0,
                                        validateStatus: null,
                                        headers: { 
                                            'User-Agent': 'Mozilla/5.0',
                                            'Referer': 'https://acefile.co/'
                                        }
                                    });
                                    
                                    if (redirectRes.status === 307 || redirectRes.status === 302) {
                                        const directUrl = redirectRes.headers.location;
                                        console.log(\`[Acefile] Direct URL ditemukan: \${directUrl.substring(0, 50)}...\`);
                                        return {
                                            url: directUrl,
                                            headers: { 'User-Agent': 'Mozilla/5.0' }
                                        };
                                    }
                                }
                            }
                        } catch(e) {
                            console.log(\`[Acefile] Mirror error: \${e.message}\`);
                        }
                    }
                }
            }
        } catch (e) {
            console.log(\`[Acefile] Axios gagal: \${e.message}, fallback ke WebView\`);
        }
        return null;
    }

    // ── Handler khusus Blogger / Google Video ────────────────
    if (embedUrl.includes('blogger.com/video') || embedUrl.includes('blogger.com/video.g')) {
        const videoUrl = await extractBloggerVideo(embedUrl, browser, req);
        if (videoUrl) return { url: videoUrl };
        throw new Error('Gagal mengekstrak video dari Blogger');
    }

    // ── Handler GDrive (Google Drive Direct Download Extractor) ──────────
    if (embedUrl.includes('drive.google.com')) {
        const axios = require('axios');
        try {
            console.log(`[GDrive] Mencoba ekstrak direct URL dari: ${embedUrl}`);
            let fileId = '';
            
            const urlObj = new URL(embedUrl);
            if (embedUrl.includes('/file/d/')) {
                fileId = embedUrl.split('/file/d/')[1].split('/')[0];
            } else if (urlObj.searchParams.has('id')) {
                fileId = urlObj.searchParams.get('id');
            }
            
            if (fileId) {
                const apiUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                const res = await axios.get(apiUrl, {
                    maxRedirects: 0,
                    validateStatus: (status) => status >= 200 && status < 400,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                
                let directUrl = '';
                let usercontentUrl = '';
                
                if (res.status === 302 || res.status === 303) {
                    usercontentUrl = res.headers.location;
                } else if (res.status === 200) {
                    usercontentUrl = apiUrl; 
                }
                
                if (usercontentUrl) {
                    const res2 = await axios.get(usercontentUrl, {
                        maxRedirects: 0,
                        validateStatus: (status) => status >= 200 && status < 400,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                    });
                    
                    if (res2.status === 302 || res2.status === 303) {
                        directUrl = res2.headers.location;
                    } else if (res2.status === 200) {
                        const html = res2.data;
                        const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);
                        if (uuidMatch && uuidMatch[1]) {
                            const uuid = uuidMatch[1];
                            directUrl = `${usercontentUrl}&confirm=t&uuid=${uuid}`;
                        } else {
                            const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
                            if (confirmMatch && confirmMatch[1]) {
                                directUrl = `${usercontentUrl}&confirm=${confirmMatch[1]}`;
                            }
                        }
                    }
                }
                
                if (directUrl) {
                    console.log(`[GDrive] Direct URL berhasil diekstrak: ${directUrl}`);
                    return {
                        url: directUrl,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    };
                }
            }
        } catch (e) {
            console.error(`[GDrive] Gagal ekstrak:`, e.message);
        }
        throw new Error('Gagal mengekstrak video dari GDrive');
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
                const vidhideUrl = m3Match[1].replace(/\\/g, '').replace(/&amp;/g, '&');
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

    // ── Handler Wibufile (File Hosting Sederhana) ──────────────────────────
    // Wibufile bukan SPA Inertia.js — strategi filedon/pucuk tidak berlaku.
    // Coba parse HTML untuk mendapat direct download/stream URL.
    // Jika gagal, return null → frontend langsung fallback WebView (tidak ada timeout 25 detik).
    if (embedUrl.includes('wibufile')) {
        const axios = require('axios');
        try {
            console.log(`[Wibufile] Mencoba ekstrak direct URL dari: ${embedUrl}`);
            // Konversi link download (/f/ atau /d/) ke link embed/view jika perlu
            let fetchUrl = embedUrl;
            if (embedUrl.match(/\/f\/[^/]+\/?$/)) {
                // /f/{id} → coba /e/{id} (embed page)
                fetchUrl = embedUrl.replace(/\/f\//, '/e/');
                console.log(`[Wibufile] Konversi ke embed URL: ${fetchUrl}`);
            }

            const { data } = await axios.get(fetchUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://v2.samehadaku.how/'
                }
            });

            // Cari URL video langsung di HTML (src video tag, atau link .mp4/.m3u8)
            const videoSrcMatch = data.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                                  data.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                                  data.match(/file:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                                  data.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

            if (videoSrcMatch && videoSrcMatch[1]) {
                const videoUrl = videoSrcMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&');
                console.log(`[Wibufile] Direct URL ditemukan!`);
                return {
                    url: videoUrl,
                    headers: {
                        'Referer': fetchUrl,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                };
            }
            console.log('[Wibufile] Tidak ada URL video di HTML, fallback ke WebView');
        } catch (e) {
            console.log(`[Wibufile] Axios gagal: ${e.message}, fallback ke WebView`);
        }
        // Kembalikan null → server.js akan kirim HTTP 500 → frontend fallback WebView
        return null;
    }

    // ── Handler Filedon.co / Pucuk (Inertia.js SPA Extractor) ──────────────
    // Filedon.co menggunakan Laravel + Inertia.js (React SPA).
    // HTML statis TIDAK mengandung URL video — perlu hit Inertia API atau download API.
    const isFilemoonLike = embedUrl.includes('filemoon') || embedUrl.includes('filelions') ||
                           embedUrl.includes('moonplayer') || embedUrl.includes('filedon') ||
                           embedUrl.includes('pucukmovie') || embedUrl.includes('pucuk');
    if (isFilemoonLike) {
        const axios = require('axios');
        try {
            // Safety net: normalisasi /f/{id} → /e/{id} untuk host yang mewajibkannya
            let normalizedEmbedUrl = embedUrl;
            const isStrictEmbedHost = ['filemoon', 'filelions', 'moonplayer', 'wibufile'].some(h => embedUrl.includes(h));
            if (isStrictEmbedHost && embedUrl.match(/\/f\/[^/]+\/?$/)) {
                normalizedEmbedUrl = embedUrl.replace(/\/f\//, '/e/');
                console.log(`[Filedon/Pucuk] Normalisasi URL: ${embedUrl} → ${normalizedEmbedUrl}`);
            }

            const originUrl = new URL(normalizedEmbedUrl);
            const baseUrl = `${originUrl.protocol}//${originUrl.hostname}`;
            const slug = originUrl.pathname.split('/').filter(Boolean).pop();
            console.log(`[Filedon/Pucuk] Extracting slug="${slug}" from: ${normalizedEmbedUrl}`);

            // Override embedUrl lokal untuk strategi-strategi di bawah
            embedUrl = normalizedEmbedUrl;
            // ── Strategi 1: Fast HTML Parse (data-page) ──
            try {
                const { data } = await axios.get(embedUrl, {
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://v2.samehadaku.how/'
                    }
                });
                
                const m = data.match(/data-page="({.*?})"/);
                if (m && m[1]) {
                    const decoded = m[1].replace(/&quot;/g, '"');
                    const parsed = JSON.parse(decoded);
                    
                    if (parsed.props && parsed.props.url) {
                        const videoUrl = parsed.props.url.replace(/\\/g, '').replace(/&amp;/g, '&');
                        console.log(`[Filedon/Pucuk] Fast HTML Parse: Found URL!`);
                        return {
                            url: videoUrl,
                            headers: {
                                'Referer': `${baseUrl}/`,
                                'Origin': baseUrl,
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            }
                        };
                    }
                }
                console.log('[Filedon/Pucuk] Fast HTML Parse tidak mengandung URL video');
            } catch (e) {
                console.log(`[Filedon/Pucuk] Fast HTML Parse gagal: ${e.message}`);
            }

            // ── Strategi 2: POST /embed/{slug}/download/start ──
            try {
                // Pertama ambil CSRF token
                const csrfRes = await axios.get(`${baseUrl}/sanctum/csrf-cookie`, {
                    timeout: 8000,
                    headers: { 'Referer': embedUrl, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    withCredentials: true
                });
                const cookies = csrfRes.headers['set-cookie'] || [];
                const xsrfToken = cookies.find(c => c.startsWith('XSRF-TOKEN='))?.split('=')[1]?.split(';')[0];
                const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

                const downloadRes = await axios.post(`${baseUrl}/embed/${slug}/download/start`, {}, {
                    timeout: 10000,
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'X-XSRF-TOKEN': xsrfToken ? decodeURIComponent(xsrfToken) : '',
                        'Referer': embedUrl,
                        'Origin': baseUrl,
                        'Cookie': cookieStr,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    }
                });
                const downloadData = downloadRes.data;
                console.log(`[Filedon/Pucuk] Download API response:`, JSON.stringify(downloadData).substring(0, 200));
                const dlStr = JSON.stringify(downloadData);
                const dlMatch = dlStr.match(/"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/i) ||
                                dlStr.match(/"url"\s*:\s*"([^"]+)"/i) ||
                                dlStr.match(/"download_url"\s*:\s*"([^"]+)"/i);
                if (dlMatch && dlMatch[1]) {
                    const videoUrl = dlMatch[1].replace(/\\/g, '');
                    console.log(`[Filedon/Pucuk] Download API: Found URL!`);
                    return {
                        url: videoUrl,
                        headers: {
                            'Referer': `${baseUrl}/`,
                            'Origin': baseUrl,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    };
                }
            } catch (e) {
                console.log(`[Filedon/Pucuk] Download API gagal: ${e.message}`);
            }

            console.log('[Filedon/Pucuk] Semua Axios strategy gagal, fallback ke Puppeteer');
        } catch (e) {
            console.log(`[Filedon/Pucuk] Error: ${e.message}, falling back to Puppeteer`);
        }
    }

    // ── Fast Generic HTML Parse (Untuk Nakama, Kuro, dll) ──
    try {
        console.log(`[Fast Generic] Mencoba ekstrak langsung dari HTML: ${embedUrl}`);
        const axios = require('axios');
        const { data } = await axios.get(embedUrl, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://v2.samehadaku.how/'
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

    let slot;
    let tempPage;
    let isTempSpaPage = false;
    try {
        const isSPA = embedUrl.includes('filedon') || embedUrl.includes('filemoon') || embedUrl.includes('filelions') || embedUrl.includes('moonplayer') || embedUrl.includes('pucukmovie') || embedUrl.includes('pucuk');

        if (isSPA) {
            const { getBrowser } = require('../puppeteer/pool');
            const browser = await getBrowser();
            tempPage = await browser.newPage();
            isTempSpaPage = true;
            await tempPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        } else {
            slot = await ambilDariExtractorPool();
            tempPage = slot.page;
            await tempPage.setExtraHTTPHeaders({
                'Referer': 'https://v2.samehadaku.how/',
                'Origin': 'https://v2.samehadaku.how'
            });
        }
        
        let videoUrl = null;

        const responseHandler = async (response) => {
            if (videoUrl) return;
            const url = response.url();
            const type = response.headers()['content-type'] || '';
            
            if (url.includes('filedon') || url.includes('wibufile')) console.log(`[Ext-Network] URL: ${url} | Type: ${type}`);

            if (
                url.includes('.m3u8') || url.includes('.mp4') || 
                type.includes('video') || type.includes('mpegurl') || type.includes('octet-stream')
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
            }, 100);
            setTimeout(() => { 
                clearInterval(checkInterval); 
                resolve(null); 
            }, 25000); // Diperpanjang ke 25s untuk SPA lambat seperti Filedon
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

        // Klik agresif berulang setiap 1.5 detik untuk menangani popup/ad dan waktu render yang bervariasi
        let clickInterval = setInterval(async () => {
            if (videoUrl) {
                clearInterval(clickInterval);
                return;
            }
            try {
                const viewport = tempPage.viewport() || { width: 800, height: 600 };
                // Klik tengah layar dua kali (biasanya 1 klik untuk ads, 1 untuk play)
                await tempPage.mouse.click(viewport.width / 2, viewport.height / 2).catch(() => {});
                await new Promise(r => setTimeout(r, 200));
                await tempPage.mouse.click(viewport.width / 2, viewport.height / 2).catch(() => {});
                
                // Coba lewat JS juga
                await tempPage.evaluate(() => {
                    try {
                        document.querySelectorAll('iframe').forEach(f => {
                            try {
                                const doc = f.contentDocument || f.contentWindow?.document;
                                if (!doc) return;
                                const btn = doc.querySelector('.play-btn, [class*="play"], button, [role="button"]');
                                if (btn) btn.click();
                                const v = doc.querySelector('video');
                                if (v) v.play().catch(() => {});
                            } catch(e) {}
                        });
                        const btn = document.querySelector('.play-btn, [class*="play"], button, [role="button"]');
                        if (btn) btn.click();
                        const v = document.querySelector('video');
                        if (v) v.play().catch(() => {});
                    } catch(e) {}
                }).catch(() => {});
            } catch (e) {}
        }, 1500);

        const finalUrl = await extractPromise;
        tempPage.off('response', responseHandler);
        
        if (finalUrl && finalUrl !== 'ERROR') {
            const cleanUrl = finalUrl.replace(/&amp;/g, '&');
            return { url: cleanUrl };
        }
        return null;
    } catch (error) {
        console.error('[Extractor] Error:', error.message);
        return null;
    } finally {
        try { if (typeof clickInterval !== 'undefined') clearInterval(clickInterval); } catch (e) {}
        if (isTempSpaPage && tempPage) {
            tempPage.close().catch(() => {});
        } else if (slot) {
            kembalikanKePool(slot);
        }
    }
}

module.exports = { scrapeVideoServers, resolveSingleServer, extractVideoUrl };
