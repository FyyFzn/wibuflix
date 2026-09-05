import { acquireFromPool, releaseToPool, getCfCookie, refreshCfCookie, globalUserAgent } from '../../puppeteer/pool.js';
import { fetchWithCF } from '../../utils/scrapeHelper.js';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { extractIframeSrc, namaServer, recordIframeReferer, getExtractorReferer } from './providers/utils.js';
import { resolveExtractor } from './providers/index.js';
import { PROVIDER_URLS } from '../../config/providerUrls.js';

export { extractIframeSrc, namaServer };

async function resolveServerIframe(page, { post, nume, type, episodeUrl }, req) {
    try {
        const result = await page.evaluate(async ({ post, nume, type, episodeUrl }) => {
            try {
                const SAMA_BASE = '${PROVIDER_URLS.SAMEHADAKU.BASE_URL}';
                const response = await fetch(`${SAMA_BASE}/wp-admin/admin-ajax.php`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': '*/*',
                        'Referer': episodeUrl,
                        'Origin': SAMA_BASE
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

        const urlMatch = result.text.match(/(https?:\/\/[^\s"'<>]{1,2048})/) || result.text.match(/(\/\/[^\s"'<>]{1,2048})/);
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

export async function scrapeVideoServers(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Scrape Fast] ${targetUrl}`);

    let slot;
    try {
        const fetchRes = await fetchWithCF(targetUrl, { fetchTimeout: 8000 });
        slot = fetchRes.slot;
        const $ = fetchRes.$;
        const html = fetchRes.html;

        if (html === '404_NOT_FOUND') {
            throw new Error("Target URL returned 404");
        }

        let judul = ($('h1[itemprop="name"]').text() || $('h1.entry-title').text() || $('title').text().replace(/[-–|].*$/, '')).trim();
        if (targetUrl.includes('nimegami.id')) {
            const epMatch = targetUrl.match(/[?&]ep=(\d+)/i);
            if (epMatch) {
                const targetEp = parseInt(epMatch[1], 10);
                judul = judul.replace(/\s*:?\s*Episode\s*\d+/i, '').trim() + ' : Episode ' + targetEp;
            }
        }

        let nav_prev = null, nav_next = null;
        $('a[data-wpel-link="internal"]').each((_, el) => {
            const cls = $(el).find('i').attr('class') || '';
            if (cls.includes('chevron-left')) nav_prev = $(el).attr('href');
            if (cls.includes('chevron-right')) nav_next = $(el).attr('href');
        });

        const servers = [];
        
        // --- NIMEGAMI SPECIAL LOGIC: Ekstrak link download per-episode dari halaman detail ---
        if (targetUrl.includes('nimegami.id')) {
            const epMatch = targetUrl.match(/[?&]ep=(\d+)/i);
            const targetEp = epMatch ? parseInt(epMatch[1], 10) : null;
            
            if (targetEp !== null) {
                $('.download, .sorasdd, .list-download, .entry-content, .box-download, #LinkDownload, .list_dl').find('h2, h3, h4, h5, strong, b, p, tr, li, div').each((_, el) => {
                    const text = $(el).text().trim();
                    if (/batch|01\s*-\s*\d+/i.test(text)) return;
                    
                    const match = text.match(/(?:episode|ep|eps)\s*(\d+)/i);
                    if (match && parseInt(match[1], 10) === targetEp) {
                        let linkElements = $(el).find('a');
                        if (linkElements.length === 0) {
                            linkElements = $(el).nextUntil('h1, h2, h3, h4, h5, hr, tr').find('a');
                        }
                        if (linkElements.length === 0 && $(el).parent().length > 0) {
                            linkElements = $(el).parent().find('a');
                        }
                        
                        linkElements.each((_, a) => {
                            const hostNameRaw = $(a).text().trim() || 'Link';
                            const hostNameLower = hostNameRaw.toLowerCase();
                            if (hostNameLower.includes('batch')) return;
                            
                            let href = $(a).attr('href');
                            
                            // Nimegami Shortlink Bypass
                            if (href && href.includes('url=')) {
                                try {
                                    const parsedUrl = new URL(href.startsWith('http') ? href : `https://nimegami.id${href}`);
                                    const urlParam = parsedUrl.searchParams.get('url');
                                    if (urlParam) {
                                        // Tes 1: Apakah direct HTTP URL (Tanpa encode base64)?
                                        if (urlParam.startsWith('http://') || urlParam.startsWith('https://')) {
                                            href = urlParam;
                                        } else {
                                            // Tes 2: Decode dari Base64 secara aman
                                            const decoded = Buffer.from(urlParam, 'base64').toString('utf8').trim();
                                            if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
                                                href = decoded;
                                            } else {
                                                // Tes 3: Decode URI Component jika berupa URL encoded biasa
                                                const uriDecoded = decodeURIComponent(urlParam);
                                                if (uriDecoded.startsWith('http://') || uriDecoded.startsWith('https://')) {
                                                    href = uriDecoded;
                                                }
                                            }
                                        }
                                    }
                                } catch (err) {
                                    console.warn(`[VideoExtractor Warning] Gagal me-decode shortlink URL (${href}): ${err.message}`);
                                }
                            }
                            
                            const allowedHosts = ['kraken', 'pdrain', 'vidhide', 'filedon', 'gofile', 'acefile', 'mega', 'pucuk', 'pixeldrain', 'wibufile', 'filemoon', 'filelions', 'moonplayer', 'mirrorupload', 'desudrive', 'ondrive', 'mirror', 'zippyshare', 'filesim', 'hxfile', 'mp4upload', 'racaty', 'cloudmail', 'vstream', 'streamhide', 'yourupload', 'filecloud', 'desustream', 'berkasdrive', 'drive', 'google', 'anonfiles', 'bayfiles', 'letupload', 'uptobox', 'mediafire', 'streamhub', 'voe', 'streamsb', 'uqload', 'odrive', 'sendwire', 'mixdrop', 'dood', 'streamtape', 'abysscdn', 'kurodrive', 'solidfiles', 'tusfiles', 'usercloud', 'userscloud', 'ulozto', 'clicknupload', 'hexupload', 'rapidgator', 'turbobit', 'nitroflare', 'filerio', 'dailyuploads', 'downace', 'filescdn', 'indishare', 'bdupload', 'uptostream', 'streamango', 'openload', 'verystream', 'clipwatching', 'vidoza', 'vidia', 'filechan', 'letsupload', 'yandex', 'mail.ru', 'dropapk', 'megaup', 'otakudesu', 'samehadaku', 'kuronime', 'nanime', 'embed', 'player', 'video', 'stream'];
                            const isAllowed = allowedHosts.some(h => hostNameLower.includes(h) || (href && href.toLowerCase().includes(h)));
                            
                            if (href && href.startsWith('http') && (!href.includes('nimegami.id') || href.includes('url=')) && isAllowed) {
                                let resText = 'MP4';
                                const parentText = $(a).parent().text() || '';
                                if (parentText.includes('1080p')) resText = '1080p';
                                else if (parentText.includes('720p')) resText = '720p';
                                else if (parentText.includes('480p')) resText = '480p';
                                else if (parentText.includes('360p')) resText = '360p';
                                
                                let normalizedHref = href;
                                const isEmbedHost = ['filemoon', 'filelions', 'moonplayer', 'wibufile'].some(h => hostNameLower.includes(h));
                                if (isEmbedHost && normalizedHref.match(/\/f\/[^/]+\/?$/)) {
                                    normalizedHref = normalizedHref.replace(/\/f\//, '/e/');
                                }
                                
                                servers.push({
                                    nama: `${resText} ${hostNameRaw}`.trim(),
                                    post: "",
                                    nume: "",
                                    type: "direct",
                                    aktif: servers.length === 0,
                                    iframeUrl: normalizedHref,
                                    namaHost: hostNameRaw
                                });
                            }
                        });
                    }
                });
            }
        }
        
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

                    let href = $(a).attr('href');
                    
                    // Nimegami Shortlink Bypass
                    if (href && href.includes('url=')) {
                        try {
                            const urlParam = new URL(href.startsWith('http') ? href : `https://nimegami.id${href}`).searchParams.get('url');
                            if (urlParam) {
                                const decoded = Buffer.from(urlParam, 'base64').toString('utf8');
                                if (decoded.startsWith('http')) {
                                    href = decoded;
                                } else if (urlParam.startsWith('http')) {
                                    href = urlParam;
                                }
                            }
                        } catch (e) {}
                    }
                    
                    const allowedHosts = ['kraken', 'pdrain', 'vidhide', 'filedon', 'gofile', 'acefile', 'mega', 'pucuk', 'pixeldrain', 'wibufile', 'filemoon', 'filelions', 'moonplayer', 'mirrorupload', 'desudrive', 'ondrive', 'mirror', 'zippyshare', 'filesim', 'hxfile', 'mp4upload', 'racaty', 'cloudmail', 'vstream', 'streamhide', 'yourupload', 'filecloud', 'desustream', 'berkasdrive', 'drive', 'google', 'anonfiles', 'bayfiles', 'letupload', 'uptobox', 'mediafire', 'streamhub', 'voe', 'streamsb', 'uqload', 'odrive', 'sendwire', 'mixdrop', 'dood', 'streamtape', 'abysscdn', 'kurodrive', 'solidfiles', 'tusfiles', 'usercloud', 'userscloud', 'ulozto', 'clicknupload', 'hexupload', 'rapidgator', 'turbobit', 'nitroflare', 'filerio', 'dailyuploads', 'downace', 'filescdn', 'indishare', 'bdupload', 'uptostream', 'streamango', 'openload', 'verystream', 'clipwatching', 'vidoza', 'vidia', 'filechan', 'letsupload', 'yandex', 'mail.ru', 'dropapk', 'megaup', 'otakudesu', 'samehadaku', 'kuronime', 'nanime', 'embed', 'player', 'video', 'stream'];
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

        // Selalu gunakan cara lama (mengambil server iframe bawaan web) untuk menghindari link shortener
        const rawServers = [];
        $('.east_player_option').each((_, el) => {
            const namaVal = $(el).find('span').text().trim() || $(el).text().trim() || 'Server';
            rawServers.push({
                nama: namaVal,
                namaHost: namaVal,
                post: $(el).attr('data-post') || '',
                nume: $(el).attr('data-nume') || '',
                type: $(el).attr('data-type') || 'schtml',
                aktif: servers.length === 0 && $(el).hasClass('on')
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

        for (const srv of servers) {
            if (srv.iframeUrl) {
                recordIframeReferer(srv.iframeUrl, targetUrl);
            }
        }
        if (iframeAktif) {
            recordIframeReferer(iframeAktif, targetUrl);
        }

        return { judul, gambar, nav_prev, nav_next, servers, iframeAktif };
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
}

export async function resolveSingleServer(targetUrl, nume, req) {
    if (!targetUrl || !nume) throw new Error("Parameter 'url' dan 'nume' wajib diisi!");
    console.log(`\n[Resolve Fast] ${targetUrl} [nume=${nume}]`);

    let slot;
    try {
        const fetchRes = await fetchWithCF(targetUrl, { fetchTimeout: 8000 });
        slot = fetchRes.slot;
        const $ = fetchRes.$;
        const html = fetchRes.html;

        if (html === '404_NOT_FOUND') {
            throw new Error("Target URL returned 404");
        }

        let post = $('.east_player_option').first().attr('data-post') || '';

        if (!post) throw new Error("Tidak menemukan ID Post (data-post) setelah fallback");
        
        // Ensure we have a page for resolveServerIframe which uses evaluate
        if (!slot) {
            slot = await acquireFromPool();
        }
        const page = slot.page;

        const iframeUrl = await resolveServerIframe(page, {
            post,
            nume,
            type: 'schtml',
            episodeUrl: targetUrl
        }, req);

        if (!iframeUrl) throw new Error("Gagal mengekstrak iframe URL dari AJAX");

        if (iframeUrl) {
            recordIframeReferer(iframeUrl, targetUrl);
        }

        return { iframeUrl, namaHost: namaServer(iframeUrl) };
    } catch (err) {
        throw err;
    } finally {
        if (slot) releaseToPool(slot);
    }
}

export async function extractVideoUrl(embedUrl, req) {
    if (!embedUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Extract] ${embedUrl}`);

    // ── 1. Bypass Mutlak untuk link yang sudah berupa file video langsung ──
    let isDirect = false;
    try {
        const parsedUrl = new URL(embedUrl);
        if (parsedUrl.pathname.match(/\.(mp4|mkv|m3u8)$/i) && !parsedUrl.pathname.includes('.php')) {
            isDirect = true;
        }
    } catch (e) {
        if (embedUrl.match(/\.(mp4|mkv|m3u8)(?:\?|$)/i) && !embedUrl.includes('.php')) {
            isDirect = true;
        }
    }
    
    if (isDirect) {
        console.log(`[Direct] URL sudah merupakan file video langsung: ${embedUrl}`);
        
        let referer = getExtractorReferer(embedUrl, req);
        let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        let cookieStr = '';

        // FIX untuk YLnime: s3.animeverse.id membutuhkan referer khusus animeverse
        if (embedUrl.includes('animeverse.id')) {
            referer = 'https://animeverse.id/';
            userAgent = globalUserAgent; // Wajib sama dengan Puppeteer agar Cookie CF Valid
            
            cookieStr = getCfCookie('s3.animeverse.id') || getCfCookie('animeverse.id');
            if (!cookieStr) {
                console.log(`[VideoExtractor] Mengambil cookie CF (Puppeteer) untuk animeverse.id (YLnime)...`);
                try {
                    const originUrl = new URL(embedUrl).origin + '/';
                    await refreshCfCookie(originUrl);
                    cookieStr = getCfCookie('s3.animeverse.id') || getCfCookie('animeverse.id');
                } catch (e) {
                    console.error('[VideoExtractor] Gagal memancing cookie CF untuk YLnime:', e.message);
                }
            }
        } else if (embedUrl.includes('animeku.org')) {
            referer = 'https://animeku.org/';
        }

        const finalHeaders = {
            'Referer': referer,
            'User-Agent': userAgent
        };
        if (cookieStr) finalHeaders['Cookie'] = cookieStr;

        return { 
            url: embedUrl,
            headers: finalHeaders
        };
    }

    // ── 2. Bypass Cepat untuk URL tanpa extractor yang dikenal ──
    // Link shortener (Racaty, Solidfiles, Zippyshare, dll) tidak memiliki extractor khusus.
    // Langsung tolak daripada membuang waktu 25 detik di Puppeteer generic.
    const extractor = resolveExtractor(embedUrl);
    if (!extractor) {
        console.log(`[Unsupported] Tidak ada extractor untuk: ${embedUrl} — Dilewati.`);
        return null;
    }

    // ── 3. Delegasikan ke modular extractors ──
    const result = await extractor.extract(embedUrl, req);
    return result;
}
