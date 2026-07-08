import { extractVideoUrl, scrapeVideoServers, resolveSingleServer } from './extractors/videoExtractor.js';
import { isMegaBlacklisted } from './stream/uploadProgressService.js';
import { globalBlacklistCache } from './stream/streamStateStore.js';
import { checkRangeSupport } from './stream/ffmpegStreamService.js';
import { getNeosatsuServers } from './scrapers/neosatsuScraperService.js';
import { getServersInternal as getOtakuServers } from '../controllers/otakudesuController.js';
import { getKuronimeServers } from '../controllers/kuronimeController.js';
import { getNanimeServers } from '../controllers/nanimeController.js';
import { getNimegamiServers } from '../controllers/nimegamiController.js';

export async function getServersBasedOnUrl(episodeUrl) {
    if (episodeUrl.includes('___neosatsu_ep___')) {
        return await getNeosatsuServers(episodeUrl);
    } else if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) {
        let realUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        return await getOtakuServers(realUrl);
    } else if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) {
        let realUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        return await getKuronimeServers(realUrl);
    } else if (episodeUrl.includes('nanimeid.net') || episodeUrl.includes('/api/nanime/servers')) {
        let realUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        return await getNanimeServers(realUrl);
    } else if (episodeUrl.includes('nimegami.id') || episodeUrl.includes('/api/nimegami/servers')) {
        let realUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        return await getNimegamiServers(realUrl);
    } else {
        return await scrapeVideoServers(episodeUrl);
    }
}

export function serverScore(host) {
    if (!host) return 0;
    const h = host.toLowerCase();
    if (h.includes('mega')) {
        if (isMegaBlacklisted()) return -1000;
        return 100;
    }
    if (h.includes('wibufile')) return 90;
    if (h.includes('pixeldrain')) return 85;
    if (h.includes('filedon') || h.includes('filemoon') || h.includes('filelions')) return 80;
    if (h.includes('mediafire')) return 75;
    if (h.includes('acefile')) return 60;
    if (h.includes('vidhide')) return 50;
    if (h.includes('kraken') || h.includes('kuroplayer') || h.includes('kuronime')) return -100; // super lambat / mati, last resort
    return 0;
}

export function getResolutionGroup(serverName) {
    const nameLower = serverName.toLowerCase();

    // Tolak format x265/HEVC karena sangat memberatkan performa HP (software decoding)
    if (nameLower.includes('x265') || nameLower.includes('hevc')) {
        return null;
    }

    if (nameLower.includes('1080') || nameLower.includes('fullhd') || nameLower.includes('full hd')) {
        return 1080;
    }
    if (nameLower.includes('720') || nameLower.includes('hd')) {
        return 720;
    }
    if (nameLower.includes('480')) {
        return 480;
    }
    if (nameLower.includes('360') || nameLower.includes('320')) {
        return 360;
    }
    return null;
}

export async function findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, logPrefix, req = null, preloadedUrlsObj = null, excludedServers = new Set()) {
    let matchedSource = null;
    try {
        const isServerExcluded = (nameOrHost) => {
            if (!nameOrHost) return false;
            const clean = nameOrHost.toString().toLowerCase().trim();
            if (excludedServers && (excludedServers.has(clean) || Array.from(excludedServers).some(ex => ex && clean.includes(ex.toString().toLowerCase())))) {
                return true;
            }
            if (globalBlacklistCache.get(`broken_srv_${clean}`) || globalBlacklistCache.get(`broken_host_${clean}`)) {
                return true;
            }
            return false;
        };

        let targetUrlPromise = getServersBasedOnUrl(episodeUrl);

        let targetData = null;
        if (!episodeTitle || !seriesTitle) {
            targetData = await targetUrlPromise;
            if (!episodeTitle) episodeTitle = targetData?.judul || '';
            if (!seriesTitle && targetData?.judul) {
                seriesTitle = targetData.judul.replace(/\s+Episode\s+\d+.*$/i, '').replace(/\s+Sub(title)?\s+Indo(nesia)?.*$/i, '').trim();
            }
            targetUrlPromise = Promise.resolve(targetData);
        }

        let urlsObj = preloadedUrlsObj || null;
        if (!urlsObj && req?.query?.urls) {
            try { urlsObj = JSON.parse(req.query.urls); } catch (e) {}
        }
        if (typeof urlsObj === 'string') {
            try { urlsObj = JSON.parse(urlsObj); } catch (e) {}
        }

        const getSourceLabel = (url) => {
            if (!url) return 'Web';
            if (url.includes('otakudesu') || url.includes('/api/otakudesu/servers')) return 'Otakudesu';
            if (url.includes('kuronime.sbs') || url.includes('/api/kuronime/servers')) return 'Kuronime';
            if (url.includes('nanimeid.net') || url.includes('/api/nanime/servers')) return 'Nanime';
            if (url.includes('nimegami.id') || url.includes('/api/nimegami/servers')) return 'Nimegami';
            return 'Samehadaku';
        };

        const fetchTasks = [
            targetUrlPromise.then(res => (res?.servers || []).map(s => ({ ...s, source: getSourceLabel(episodeUrl) }))).catch(() => [])
        ];

        if (urlsObj && typeof urlsObj === 'object') {
            console.info(`${logPrefix} Mengambil URL alternatif dari metadata urls:`, JSON.stringify(urlsObj));
            for (const [provider, provUrl] of Object.entries(urlsObj)) {
                if (!provUrl || typeof provUrl !== 'string') continue;
                if (episodeUrl.includes(provUrl) || (provider === 'otakudesu' && episodeUrl.includes('otakudesu')) || (provider === 'kuronime' && episodeUrl.includes('kuronime')) || (provider === 'samehadaku' && episodeUrl.includes('samehadaku')) || (provider === 'nanime' && episodeUrl.includes('nanime')) || (provider === 'neosatsu' && episodeUrl.includes('neosatsu')) || (provider === 'nimegami' && episodeUrl.includes('nimegami'))) {
                    continue;
                }
                const label = provider.charAt(0).toUpperCase() + provider.slice(1);
                let fetchUrl = provUrl;
                if (fetchUrl.startsWith('/api/')) {
                    try {
                        fetchUrl = new URL('http://localhost' + fetchUrl).searchParams.get('url') || fetchUrl;
                    } catch (e) {}
                }
                fetchTasks.push(getServersBasedOnUrl(fetchUrl).then(res => (res?.servers || []).map(s => ({ ...s, source: label }))).catch(err => {
                    console.warn(`${logPrefix} Gagal fetch provider ${label} (${fetchUrl}):`, err.message);
                    return [];
                }));
            }
        }

        const resultsArray = await Promise.all(fetchTasks);
        const servers = resultsArray.flat();

        if (servers.length === 0) {
            return { matchedSource: null, error: 'Tidak ada server download/streaming yang ditemukan di halaman episode.' };
        }

        const groups = { 1080: [], 720: [], 480: [], 360: [] };
        for (const srv of servers) {
            if (srv.namaHost && srv.namaHost.toLowerCase().includes('ma') && isMegaBlacklisted()) {
                continue;
            }
            const resGroup = getResolutionGroup(srv.nama);
            if (resGroup && groups[resGroup]) groups[resGroup].push(srv);
        }

        for (const resVal of [1080, 720, 480, 360]) {
            if (groups[resVal].length > 0) {
                groups[resVal].sort((a, b) => {
                    const scoreA = serverScore(a.namaHost);
                    const scoreB = serverScore(b.namaHost);

                    const aIsNegative = scoreA < 0 ? 1 : 0;
                    const bIsNegative = scoreB < 0 ? 1 : 0;
                    if (aIsNegative !== bIsNegative) return aIsNegative - bIsNegative;

                    if (scoreB !== scoreA) return scoreB - scoreA;

                    const aIsM3u8 = a.type === 'direct' && a.iframeUrl && a.iframeUrl.includes('.m3u8') ? 1 : 0;
                    const bIsM3u8 = b.type === 'direct' && b.iframeUrl && b.iframeUrl.includes('.m3u8') ? 1 : 0;
                    if (aIsM3u8 !== bIsM3u8) return bIsM3u8 - aIsM3u8;

                    return 0;
                });

                const serverNames = groups[resVal].map(s => s.namaHost).join(', ');
                console.info(`${logPrefix} Menguji kandidat ${resVal}p: ${serverNames}`);
            }

            for (const srv of groups[resVal]) {
                try {
                    if (srv.namaHost && srv.namaHost.toLowerCase().includes('mega') && isMegaBlacklisted()) {
                        console.warn(`${logPrefix} Melewati ${srv.namaHost} karena sedang di-blacklist.`);
                        continue;
                    }
                    if (isServerExcluded(srv.namaHost) || isServerExcluded(srv.nama)) {
                        console.warn(`${logPrefix} Melewati server ${srv.namaHost || srv.nama} karena sebelumnya gagal/putus koneksi.`);
                        continue;
                    }
                    
                    let iframeUrlToExtract = srv.iframeUrl;
                    if (!iframeUrlToExtract && srv.nume) {
                        try {
                            const res = await resolveSingleServer(episodeUrl, srv.nume, req);
                            if (res && res.iframeUrl) {
                                iframeUrlToExtract = res.iframeUrl;
                                srv.namaHost = res.namaHost;
                            }
                            if (srv.namaHost && srv.namaHost.toLowerCase().includes('mega') && isMegaBlacklisted()) {
                                console.warn(`${logPrefix} Melewati ${srv.namaHost} (setelah resolve) karena sedang di-blacklist.`);
                                continue;
                            }
                            if (isServerExcluded(srv.namaHost) || isServerExcluded(srv.nama)) {
                                console.warn(`${logPrefix} Melewati ${srv.namaHost || srv.nama} (setelah resolve) karena sebelumnya gagal/putus koneksi.`);
                                continue;
                            }
                        } catch (resolveErr) {
                            console.error(`${logPrefix} Gagal resolve AJAX untuk server ${srv.namaHost || srv.nama}:`, resolveErr.message);
                            continue;
                        }
                    }

                    const extracted = await extractVideoUrl(iframeUrlToExtract, req);
                    if (extracted && extracted.url && !extracted.webviewOnly) {
                        if (extracted.url.toLowerCase().includes('mega.nz') && isMegaBlacklisted()) {
                            console.warn(`${logPrefix} Melewati extracted url Mega karena sedang di-blacklist.`);
                            continue;
                        }
                        let extractedHost = '';
                        try { extractedHost = new URL(extracted.url).hostname.toLowerCase(); } catch(e){}
                        if (isServerExcluded(extractedHost)) {
                            console.warn(`${logPrefix} Melewati extracted URL ${extractedHost} karena sebelumnya gagal/putus koneksi.`);
                            continue;
                        }
                        const finalHeaders = { ...(extracted.headers || {}), ...(srv.headers || {}) };
                        try {
                            await checkRangeSupport(extracted.url, finalHeaders);
                            matchedSource = { 
                                url: extracted.url, 
                                headers: finalHeaders,
                                server: srv.namaHost || srv.nama || 'unknown',
                                source: srv.source || 'Unknown',
                                host: extractedHost || ''
                            };
                            console.info(`${logPrefix} ✓ Menemukan source video (${resVal}p) dari ${srv.source} [${srv.namaHost}]`);
                            break;
                        } catch (pingErr) {
                            if (pingErr.message === 'HTTP_429_LIMIT') {
                                console.warn(`${logPrefix} ${srv.namaHost} terkena limit kuota (429), lompat ke server berikutnya...`);
                                continue;
                            }
                            console.warn(`${logPrefix} Server ${srv.namaHost} gagal uji koneksi (${pingErr.message}), lompat ke server berikutnya...`);
                            continue;
                        }
                    }
                } catch (e) {
                    console.error(`${logPrefix} Gagal mengekstrak dari server ${srv.namaHost}:`, e.message);
                }
            }
            if (matchedSource) break;
        }

        return { matchedSource, error: null };
    } catch (err) {
        return { matchedSource: null, error: err.message };
    }
}
