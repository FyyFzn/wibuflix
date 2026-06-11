import { acquireFromPool, releaseToPool, globalCfCookie, globalUserAgent, refreshCfCookie } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { extractIframeSrc, namaServer } from './extractors/utils.js';
import { resolveExtractor } from './extractors/index.js';
import { loadLocalDatabase } from '../sync/anime_sync.js';
import { loadUnifiedDatabase } from '../sync/unified_sync.js';
import { getEpisodes } from './episodes.js';

export { extractIframeSrc, namaServer };

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

export async function scrapeVideoServers(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.log(`\n[Scrape Fast] ${targetUrl}`);

    let html = '';
    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': globalUserAgent,
                'Cookie': globalCfCookie
            },
            timeout: 8000
        });
        html = response.data;
    } catch (err) {
        console.log(`[Scrape Fast] Axios gagal (${err.message}). Fallback...`);
        if (err.response && (err.response.status === 403 || err.response.status === 503)) {
            await refreshCfCookie();
        }
    }

    let slot;
    try {
        if (!html || html.trim() === '' || html.includes('cf-browser-verification') || html.includes('Just a moment')) {
            console.log(`[Scrape] Fetch Axios gagal/terblokir Cloudflare. Fallback ke Puppeteer...`);
            slot = await acquireFromPool();
            const page = slot.page;
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
                    
                    const allowedHosts = ['kraken', 'pucuk', 'pixeldrain', 'wibufile', 'vidhide', 'filedon', 'filemoon', 'filelions', 'moonplayer', 'gofile', 'acefile', 'mirrorupload', 'mega'];
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
        if (slot) releaseToPool(slot);
    }
}

export async function resolveSingleServer(targetUrl, nume, req) {
    if (!targetUrl || !nume) throw new Error("Parameter 'url' dan 'nume' wajib diisi!");
    console.log(`\n[Resolve Fast] ${targetUrl} [nume=${nume}]`);

    let html = '';
    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': globalUserAgent,
                'Cookie': globalCfCookie
            },
            timeout: 8000
        });
        html = response.data;
    } catch (err) {
        console.log(`[Resolve Fast] Axios gagal (${err.message}). Fallback...`);
        if (err.response && (err.response.status === 403 || err.response.status === 503)) {
            await refreshCfCookie();
        }
    }

    let slot;
    try {
        let $ = cheerio.load(html);
        let post = $('.east_player_option').first().attr('data-post') || '';

        // Fallback to Puppeteer page.goto if fetch failed (Cloudflare IUAM / Tarpit)
        if (!post) {
            console.log(`[Resolve] Fetch Axios gagal/terblokir Cloudflare. Fallback ke Puppeteer...`);
            slot = await acquireFromPool();
            const page = slot.page;
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            html = await page.content();
            $ = cheerio.load(html);
            post = $('.east_player_option').first().attr('data-post') || '';
        }

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

    // ── 2. Bypass Cepat untuk Server yang Tidak Didukung (Mencegah Timeout 25 Detik) ──
    const unsupportedHosts = ['mirrorupload', 'gofile'];
    if (unsupportedHosts.some(h => embedUrl.toLowerCase().includes(h))) {
        console.log(`[Unsupported] Melewati ekstraksi Puppeteer untuk: ${embedUrl}`);
        return null; // Akan langsung gagal karena sistem hanya menggunakan Blob
    }

    // ── 3. Delegasikan ke modular extractors ──
    const extractor = resolveExtractor(embedUrl);
    return await extractor.extract(embedUrl, req);
}

function extractEpisodeNumber(title) {
    if (!title) return null;
    // Standard episode matching (Episode/Eps/Ep followed by digits)
    const stdMatch = title.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i);
    if (stdMatch) return parseFloat(stdMatch[1]);

    // OVA / Special matching (OVA 1, Special 3, SP 2, etc.)
    const ovaMatch = title.match(/(?:OVA|Special|SP)\s*(\d+(\.\d+)?)/i);
    if (ovaMatch) return parseFloat(ovaMatch[1]);

    // Standalone trailing digit matching
    const fallbackMatch = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallbackMatch) return parseFloat(fallbackMatch[1]);

    return null;
}

export async function getAlternativeServersSamehadaku(seriesTitle, episodeTitle) {
    if (!seriesTitle || !episodeTitle) return [];

    try {
        let samehadakuUrl = null;

        // 1. Try unified database first for mapping
        const unifiedDb = loadUnifiedDatabase();
        if (unifiedDb && unifiedDb.length > 0) {
            const query = seriesTitle.toLowerCase().trim();
            // Try exact title / alias match
            let matchedEntry = unifiedDb.find(item => 
                item.title.toLowerCase() === query || 
                (item.aliases && item.aliases.some(a => a.toLowerCase() === query))
            );

            // Fuzzy match in unified_db if exact match not found
            if (!matchedEntry) {
                const queryWords = query.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2);
                let bestMatch = null;
                let maxMatches = 0;
                for (const item of unifiedDb) {
                    const titlesToTry = [item.title, ...(item.aliases || [])];
                    for (const t of titlesToTry) {
                        const itemTitle = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
                        let matches = 0;
                        for (const w of queryWords) {
                            if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(itemTitle)) matches++;
                        }
                        if (matches > maxMatches) {
                            maxMatches = matches;
                            bestMatch = item;
                        }
                    }
                }
                if (bestMatch && maxMatches >= queryWords.length / 2) {
                    matchedEntry = bestMatch;
                }
            }

            if (matchedEntry && matchedEntry.sources && matchedEntry.sources.samehadaku) {
                samehadakuUrl = matchedEntry.sources.samehadaku.url;
            }
        }

        // 2. Fallback to local anime database (samehadaku)
        if (!samehadakuUrl) {
            const samehadakuDb = loadLocalDatabase();
            if (samehadakuDb && samehadakuDb.length > 0) {
                const query = seriesTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                const queryWords = query.split(' ').filter(w => w.length > 2);

                let bestMatch = null;
                let maxMatches = 0;

                for (const item of samehadakuDb) {
                    const itemTitle = item.judul.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
                    let matches = 0;
                    for (const w of queryWords) {
                        if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(itemTitle)) matches++;
                    }
                    if (matches > maxMatches) {
                        maxMatches = matches;
                        bestMatch = item;
                    }
                }

                if (bestMatch && maxMatches >= queryWords.length / 2) {
                    samehadakuUrl = bestMatch.url;
                }
            }
        }

        if (!samehadakuUrl) {
            console.log(`[Samehadaku Alt] Tidak menemukan kecocokan seri untuk: "${seriesTitle}"`);
            return [];
        }

        console.log(`[Samehadaku Alt] Menemukan kecocokan seri Samehadaku: "${samehadakuUrl}"`);

        const targetEpNum = extractEpisodeNumber(episodeTitle);
        if (targetEpNum === null) return [];

        const details = await getEpisodes(samehadakuUrl);
        if (!details || !details.daftar_episode) return [];

        let targetEpUrl = null;
        for (const ep of details.daftar_episode) {
            const epNum = extractEpisodeNumber(ep.judul);
            if (epNum === targetEpNum) {
                targetEpUrl = ep.url;
                break;
            }
        }

        if (!targetEpUrl) {
            console.log(`[Samehadaku Alt] Tidak menemukan episode ${targetEpNum} di Samehadaku`);
            return [];
        }

        console.log(`[Samehadaku Alt] Menemukan episode URL alternatif: "${targetEpUrl}"`);
        const scrapeResult = await scrapeVideoServers(targetEpUrl);
        return scrapeResult.servers || [];
    } catch (e) {
        console.error("[Samehadaku Alternative Error]", e.message);
        return [];
    }
}
