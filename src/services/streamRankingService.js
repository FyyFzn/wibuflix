import { extractVideoUrl, scrapeVideoServers, resolveSingleServer } from './extractors/videoExtractor.js';
import { isMegaBlacklisted } from './stream/uploadProgressService.js';
import { globalBlacklistCache } from './stream/streamStateStore.js';
import { checkRangeSupport } from './stream/ffmpegStreamService.js';
import { ProviderRegistry } from './ProviderRegistry.js';

export async function getServersBasedOnUrl(episodeUrl) {
    return await ProviderRegistry.fetchServers(episodeUrl);
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

export function getProviderKey(url) {
    if (!url) return '';
    const lower = url.toString().toLowerCase();
    
    // Manual fallback API lokal
    if (lower.startsWith('/anime/')) return 'otakudesu';
    if (lower.startsWith('neosatsu')) return 'neosatsu';

    try {
        const parsed = new URL(lower);
        // Hapus 'www.' agar lebih seragam (e.g. www.samehadaku.tv -> samehadaku.tv)
        return parsed.hostname.replace(/^www\./, '');
    } catch {
        return lower.split('/')[2] || lower;
    }
}

export function isEpisodeProviderBlacklisted(provider, slugs) {
    if (!provider || !slugs) return false;
    const prov = provider.toString().toLowerCase().trim();
    if (!prov) return false;

    const sList = [];
    if (slugs.seriesSlug) {
        sList.push(slugs.seriesSlug);
        const clean = slugs.seriesSlug.replace(/^(mal-|db-)\d+_/, '');
        if (clean && !sList.includes(clean)) sList.push(clean);
    }
    if (slugs.oldSeriesSlug && slugs.oldSeriesSlug !== slugs.seriesSlug) {
        sList.push(slugs.oldSeriesSlug);
        const cleanOld = slugs.oldSeriesSlug.replace(/^(mal-|db-)\d+_/, '');
        if (cleanOld && !sList.includes(cleanOld)) sList.push(cleanOld);
    }
    const eList = [];
    if (slugs.episodeSlug) {
        eList.push(slugs.episodeSlug);
    }

    for (const s of sList) {
        for (const e of eList) {
            if (globalBlacklistCache.get(`broken_ep_prov_${s}_${e}_${prov}`)) {
                return true;
            }
        }
    }
    return false;
}

export function blacklistEpisodeProvider(provider, slugs) {
    if (!provider || !slugs) return;
    const prov = provider.toString().toLowerCase().trim();
    if (!prov) return;

    const sList = [];
    if (slugs.seriesSlug) {
        sList.push(slugs.seriesSlug);
        const clean = slugs.seriesSlug.replace(/^(mal-|db-)\d+_/, '');
        if (clean && !sList.includes(clean)) sList.push(clean);
    }
    if (slugs.oldSeriesSlug && slugs.oldSeriesSlug !== slugs.seriesSlug) {
        sList.push(slugs.oldSeriesSlug);
        const cleanOld = slugs.oldSeriesSlug.replace(/^(mal-|db-)\d+_/, '');
        if (cleanOld && !sList.includes(cleanOld)) sList.push(cleanOld);
    }
    const eList = slugs.episodeSlug ? [slugs.episodeSlug] : [];

    for (const s of sList) {
        for (const e of eList) {
            globalBlacklistCache.set(`broken_ep_prov_${s}_${e}_${prov}`, true);
        }
    }
}

export function checkUrlBlacklisted(url, currentSlugs = null) {
    if (!url) return false;
    const checkUrls = [url];
    if (url.includes('?url=')) {
        try {
            const dec = decodeURIComponent(url.split('?url=')[1]);
            if (dec && !checkUrls.includes(dec)) checkUrls.push(dec);
        } catch(e) {}
    }
    for (const u of checkUrls) {
        if (globalBlacklistCache.get(`broken_url_${u}`)) return true;
        const stripped = u.replace(/\/+$/, '');
        if (stripped !== u && globalBlacklistCache.get(`broken_url_${stripped}`)) return true;
    }
    const prov = getProviderKey(url);
    if (prov) {
        if (globalBlacklistCache.get(`broken_provider_${prov}`)) return true;
        if (currentSlugs && isEpisodeProviderBlacklisted(prov, currentSlugs)) return true;
    }
    return false;
}

export async function findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, logPrefix, req = null, preloadedUrlsObj = null, excludedServers = new Set(), slugs = null, abortSignal = null) {
    let matchedSource = null;
    try {
        const isServerExcluded = (nameOrHost, currentSlugs = slugs) => {
            if (!nameOrHost) return false;
            const clean = nameOrHost.toString().toLowerCase().trim();
            if (excludedServers && (excludedServers.has(clean) || Array.from(excludedServers).some(ex => ex && clean.includes(ex.toString().toLowerCase())))) {
                return true;
            }
            if (globalBlacklistCache.get(`broken_srv_${clean}`) || globalBlacklistCache.get(`broken_host_${clean}`)) {
                return true;
            }
            if (currentSlugs) {
                const prov = getProviderKey(clean);
                if (prov && isEpisodeProviderBlacklisted(prov, currentSlugs)) return true;
            }
            return false;
        };

        let targetUrlPromise = checkUrlBlacklisted(episodeUrl, slugs)
            ? Promise.resolve({ servers: [] })
            : getServersBasedOnUrl(episodeUrl);

        let targetData = null;
        if (!episodeTitle || !seriesTitle) {
            targetData = await targetUrlPromise;
            if (!episodeTitle) episodeTitle = targetData?.judul || '';
            if (!seriesTitle && targetData?.judul) {
                seriesTitle = targetData.judul.replace(/\s+Episode\s+\d+.*$/i, '').replace(/\s+Sub(title)?\s+Indo(nesia)?.*$/i, '').trim();
            }
            if (!checkUrlBlacklisted(episodeUrl)) {
                targetUrlPromise = Promise.resolve(targetData);
            }
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
            const prov = getProviderKey(url);
            if (prov) return prov.charAt(0).toUpperCase() + prov.slice(1);
            return 'Samehadaku';
        };

        const fetchTasks = []; // Provider cepat (Otakudesu, Samehadaku, Nanime, dll)
        const slowFetchTasks = []; // Provider lambat yang butuh Puppeteer penuh (Kuronime)

        const isSlowProvider = (url) => url && (url.includes('kuronime') || url.includes('/api/kuronime/'));

        // Primary URL task
        const primaryTask = targetUrlPromise.then(res => (res?.servers || []).map(s => ({ ...s, source: getSourceLabel(episodeUrl) }))).catch(() => []);
        if (isSlowProvider(episodeUrl)) {
            slowFetchTasks.push(primaryTask);
        } else {
            fetchTasks.push(primaryTask);
        }

        if (urlsObj && typeof urlsObj === 'object') {
            console.info(`${logPrefix} Mengambil URL alternatif dari metadata urls:`, JSON.stringify(urlsObj));
            const urlList = Array.isArray(urlsObj) ? urlsObj : Object.values(urlsObj);
            
            for (const provUrl of urlList) {
                if (!provUrl || typeof provUrl !== 'string') continue;
                
                // Ekstrak provider dari URL secara mandiri (bukan dari key object)
                const provider = getProviderKey(provUrl) || 'unknown';
                
                if (checkUrlBlacklisted(provUrl, slugs) || globalBlacklistCache.get(`broken_provider_${provider}`) || isEpisodeProviderBlacklisted(provider, slugs)) {
                    console.info(`${logPrefix} Melewati provider [${provider.toUpperCase()}] karena dilaporkan rusak/blacklisted untuk episode ini.`);
                    continue;
                }
                if (episodeUrl.includes(provUrl) || provider === getProviderKey(episodeUrl)) {
                    continue;
                }
                
                const label = provider !== 'unknown' ? (provider.charAt(0).toUpperCase() + provider.slice(1)) : 'Alternative';
                let fetchUrl = provUrl;
                if (fetchUrl.startsWith('/api/')) {
                    try {
                        fetchUrl = new URL('http://localhost' + fetchUrl).searchParams.get('url') || fetchUrl;
                    } catch (e) {}
                }
                const task = getServersBasedOnUrl(fetchUrl).then(res => (res?.servers || []).map(s => ({ ...s, source: label }))).catch(err => {
                    console.warn(`${logPrefix} Gagal fetch provider ${label} (${fetchUrl}):`, err.message);
                    return [];
                });

                if (isSlowProvider(fetchUrl) || provider === 'kuronime') {
                    slowFetchTasks.push(task);
                } else {
                    fetchTasks.push(task);
                }
            }
        }

        // TWO-PHASE FETCH STRATEGY:
        // Phase 1: Tunggu provider cepat (Otakudesu, Samehadaku, Nanime) selesai
        // Phase 2: Jika provider cepat sudah memberikan hasil → beri Kuronime grace period 5 detik
        //          Jika TIDAK ada hasil dari provider cepat → tunggu Kuronime penuh (max 45 detik)
        let servers = [];

        if (abortSignal && abortSignal.aborted) {
            console.info(`${logPrefix} Proses dibatalkan pengguna sebelum menunggu provider cepat.`);
            return { matchedSource: null, error: 'UPLOAD_CANCELLED' };
        }

        if (fetchTasks.length > 0) {
            const fastResults = await Promise.all(fetchTasks);
            servers = fastResults.flat();
        }

        if (abortSignal && abortSignal.aborted) {
            console.info(`${logPrefix} Proses dibatalkan pengguna sebelum menunggu provider lambat.`);
            return { matchedSource: null, error: 'UPLOAD_CANCELLED' };
        }

        if (slowFetchTasks.length > 0) {
            const has1080 = servers.some(s => (s.kualitas && s.kualitas.includes('1080')) || (s.nama && s.nama.includes('1080')));
            const hasBlacklistedProv = slugs && ['otakudesu', 'nanime', 'samehadaku'].some(p => isEpisodeProviderBlacklisted(p, slugs));
            const gracePeriod = servers.length === 0 ? 45000 : (!has1080 || hasBlacklistedProv ? 15000 : 5000);
            const phaseLabel = servers.length === 0 ? 'full wait 45s' : (!has1080 || hasBlacklistedProv ? 'grace period 15s' : 'grace period 5s');
            console.info(`${logPrefix} Provider cepat menghasilkan ${servers.length} server. Menunggu Kuronime (${phaseLabel})...`);

            const slowWithTimeout = slowFetchTasks.map(task =>
                Promise.race([
                    task,
                    new Promise(resolve => setTimeout(() => {
                        console.info(`${logPrefix} Kuronime timeout setelah ${gracePeriod / 1000}s — melanjutkan tanpa Kuronime.`);
                        resolve([]);
                    }, gracePeriod))
                ])
            );
            const slowResults = await Promise.all(slowWithTimeout);
            const slowServers = slowResults.flat();
            if (slowServers.length > 0) {
                console.info(`${logPrefix} ✓ Kuronime berhasil: ${slowServers.length} server ditambahkan ke kandidat.`);
                servers = servers.concat(slowServers);
            }
        }

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

                    if (slugs?.seriesSlug && slugs?.episodeSlug) {
                        const provA = (a.source || '').toLowerCase();
                        const provB = (b.source || '').toLowerCase();
                        let aBrokenProv = provA && globalBlacklistCache.get(`broken_ep_prov_${slugs.seriesSlug}_${slugs.episodeSlug}_${provA}`) ? 1 : 0;
                        let bBrokenProv = provB && globalBlacklistCache.get(`broken_ep_prov_${slugs.seriesSlug}_${slugs.episodeSlug}_${provB}`) ? 1 : 0;
                        if (aBrokenProv !== bBrokenProv) return aBrokenProv - bBrokenProv;
                    }

                    if (scoreB !== scoreA) return scoreB - scoreA;

                    const aIsM3u8 = a.type === 'direct' && a.iframeUrl && a.iframeUrl.includes('.m3u8') ? 1 : 0;
                    const bIsM3u8 = b.type === 'direct' && b.iframeUrl && b.iframeUrl.includes('.m3u8') ? 1 : 0;
                    if (aIsM3u8 !== bIsM3u8) return bIsM3u8 - aIsM3u8;

                    return 0;
                });

                const serverNames = groups[resVal].map(s => s.namaHost || s.nama || 'Server').filter(Boolean).join(', ');
                console.info(`${logPrefix} Menguji kandidat ${resVal}p: ${serverNames}`);
            }

            for (const srv of groups[resVal]) {
                if (abortSignal && abortSignal.aborted) {
                    console.info(`${logPrefix} Proses pencarian dibatalkan oleh pengguna (abortSignal).`);
                    return { matchedSource: null, error: 'UPLOAD_CANCELLED' };
                }
                
                try {
                    if (srv.namaHost && srv.namaHost.toLowerCase().includes('mega') && isMegaBlacklisted()) {
                        console.warn(`${logPrefix} Melewati ${srv.namaHost} karena sedang di-blacklist.`);
                        continue;
                    }
                    if (isServerExcluded(srv.namaHost, slugs) || isServerExcluded(srv.nama, slugs)) {
                        console.warn(`${logPrefix} Melewati server ${srv.namaHost || srv.nama} karena sebelumnya gagal/putus koneksi atau provider blacklisted.`);
                        continue;
                    }
                    if (srv.source && isEpisodeProviderBlacklisted(srv.source, slugs)) {
                        console.warn(`${logPrefix} Melewati server [${srv.source}] (${srv.namaHost || srv.nama}) karena provider telah dilaporkan rusak untuk episode ini.`);
                        continue;
                    }
                    
                    let iframeUrlToExtract = srv.iframeUrl;
                    if (!iframeUrlToExtract && srv.nume) {
                        try {
                            const res = await resolveSingleServer(episodeUrl, srv.nume, req);
                            if (res && res.iframeUrl) {
                                iframeUrlToExtract = res.iframeUrl;
                                srv.namaHost = res.namaHost || srv.namaHost || srv.nama;
                            }
                            if (srv.namaHost && srv.namaHost.toLowerCase().includes('mega') && isMegaBlacklisted()) {
                                console.warn(`${logPrefix} Melewati ${srv.namaHost} (setelah resolve) karena sedang di-blacklist.`);
                                continue;
                            }
                            if (isServerExcluded(srv.namaHost, slugs) || isServerExcluded(srv.nama, slugs)) {
                                console.warn(`${logPrefix} Melewati ${srv.namaHost || srv.nama} (setelah resolve) karena sebelumnya gagal/putus koneksi atau provider blacklisted.`);
                                continue;
                            }
                        } catch (resolveErr) {
                            console.error(`${logPrefix} Gagal resolve AJAX untuk server ${srv.namaHost || srv.nama}:`, resolveErr.message);
                            if (slugs?.seriesSlug && slugs?.episodeSlug && srv.source) {
                                globalBlacklistCache.set(`broken_ep_prov_${slugs.seriesSlug}_${slugs.episodeSlug}_${srv.source.toLowerCase()}`, true);
                            }
                            continue;
                        }
                    }

                    if (!iframeUrlToExtract || typeof iframeUrlToExtract !== 'string' || !iframeUrlToExtract.trim()) {
                        continue;
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
                            if (slugs?.seriesSlug && slugs?.episodeSlug && srv.source) {
                                globalBlacklistCache.set(`broken_ep_prov_${slugs.seriesSlug}_${slugs.episodeSlug}_${srv.source.toLowerCase()}`, true);
                            }
                            continue;
                        }
                    }
                } catch (e) {
                    console.error(`${logPrefix} Gagal mengekstrak dari server ${srv.namaHost}:`, e.message);
                    if (slugs?.seriesSlug && slugs?.episodeSlug && srv.source) {
                        globalBlacklistCache.set(`broken_ep_prov_${slugs.seriesSlug}_${slugs.episodeSlug}_${srv.source.toLowerCase()}`, true);
                    }
                }
            }
            if (matchedSource) break;
        }

        return { matchedSource, error: null };
    } catch (err) {
        return { matchedSource: null, error: err.message };
    }
}
