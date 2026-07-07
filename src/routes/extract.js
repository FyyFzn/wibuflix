import express from 'express';
import { extractVideoUrl, scrapeVideoServers, resolveSingleServer } from '../services/extractors/videoExtractor.js';
import { checkUploadStatus, checkUploadStatusWithFallback, uploadStream, getBlobPath, getBlobUrl, markUploadFailed, hasActiveUploadForSeries, getActiveUploadCount, getUploadProgress, cancelUpload, cancelAllUploads, checkRangeSupport, isMegaBlacklisted, invalidateAndDeleteBlob } from '../utils/azureUploader.js';
import { normalizeTitleForMatch, extractEpNumStrict } from '../utils/stringUtils.js';
import { getNeosatsuServers } from '../controllers/neosatsuController.js';
import { getServersInternal as getOtakuServers } from '../controllers/otakudesuController.js';
import { getKuronimeServers } from '../controllers/kuronimeController.js';
import { getNanimeServers } from '../controllers/nanimeController.js';
import { backgroundQueue } from '../utils/queueManager.js';
import QueueTask from '../models/QueueTask.js';
import { getCache } from '../utils/cacheManager.js';
import { findAnimeInDatabase } from '../services/episodeService.js';
import { resolveCatalogSource } from '../utils/animeMatcher.js';

const proxyCache = getCache('proxy-cache', 3600); // Bersih otomatis setelah 1 jam

async function waitForUploadCompletion(slugsToCheck, episodeSlugsToCheck, item) {
    let attempts = 0;
    while (attempts < 120) { // Max wait 10 minutes (120 * 5s)
        await new Promise(res => setTimeout(res, 5000));
        attempts++;
        const currentCheck = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        if (currentCheck.status === 'READY') {
            console.info(`[Queue] ${item.episodeTitle} selesai diunggah oleh proses lain.`);
            return;
        }
        if (currentCheck.status === 'FAILED') {
            throw new Error('Proses upload oleh proses lain mengalami kegagalan.');
        }
        if (currentCheck.status !== 'UPLOADING') {
            throw new Error('Proses upload terputus atau dibatalkan.');
        }
    }
    throw new Error('Waktu tunggu upload oleh proses lain habis (timeout).');
}

// Setup background queue processor
backgroundQueue.setProcessor(async (item) => {
    // Canonical Database Identity Lookup
    item.uniqueId = await resolveCanonicalUniqueId(item.seriesUrl, item.episodeUrl, item.seriesTitle, item.uniqueId);
    // Extract slugs with uniqueId to get full fallback slugsToCheck array
    const { episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
    
    // Cek apakah sudah selesai atau sedang di proses oleh request lain
    const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
    if (checkInfo.status === 'READY') {
        console.info(`[Queue] ${item.episodeTitle} sudah tersedia di server. Langsung diselesaikan.`);
        return; // Otomatis menjadi COMPLETED
    }
    if (checkInfo.status === 'UPLOADING') {
        console.info(`[Queue] ${item.episodeTitle} sedang diunggah oleh proses lain. Menunggu hingga selesai...`);
        await waitForUploadCompletion(slugsToCheck, episodeSlugsToCheck, item);
        return;
    }
    
    // Jalankan prefetchOneEpisode dengan source 'queue' dan bawa slugsToCheck serta episodeTitle
    const result = await prefetchOneEpisode(item.seriesSlug, item.episodeUrl, item.seriesTitle, 'queue', null, slugsToCheck, item.episodeTitle);
    if (!result.success) {
        // Jika gagal karena error beneran, lemparkan error untuk trigger retry
        if (result.reason === 'Already processing or failed' || result.reason === 'Already extracting') {
            console.info(`[Queue] ${item.episodeTitle} sedang diproses di background. Menunggu hingga selesai...`);
            await waitForUploadCompletion(slugsToCheck, episodeSlugsToCheck, item);
            return;
        }
        throw new Error(result.reason || 'Prefetch failed');
    }
});

const router = express.Router();
const activeExtractions = new Set();
let prefetchAbortController = new AbortController();

/**
 * Canonical Database Identity Lookup:
 * Memastikan bahwa dari web mana pun (Samehadaku, Otakudesu, Kuronime, Neosatsu) anime diputar,
 * jika uniqueId belum ada dari frontend, kita secara otomatis mengaitkannya dengan malId atau ObjectId
 * dari database MongoDB lokal agar selalu masuk ke dalam 1 folder kanonikal yang sama di Azure Blob Storage!
 */
export async function resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, currentUniqueId) {
    if (currentUniqueId && currentUniqueId.toString().trim() !== '') {
        return currentUniqueId.toString().trim();
    }
    
    try {
        let dbAnime = null;
        if (seriesUrl || episodeUrl) {
            const targetUrl = seriesUrl || episodeUrl;
            dbAnime = await findAnimeInDatabase({ targetUrl });
        }
        
        if (!dbAnime && seriesTitle) {
            for (const prov of ['samehadaku', 'otakudesu', 'kuronime', 'nanime', 'neosatsu']) {
                const res = await resolveCatalogSource(seriesTitle, prov);
                if (res && res.entry) {
                    dbAnime = res.entry;
                    break;
                }
            }
        }
        
        if (dbAnime) {
            if (dbAnime.malId) {
                console.info(`[CanonicalLookup] ✓ Mengaitkan "${seriesTitle || seriesUrl}" dengan mal-${dbAnime.malId} dari database.`);
                return `mal-${dbAnime.malId}`;
            } else if (dbAnime._id) {
                console.info(`[CanonicalLookup] ✓ Mengaitkan "${seriesTitle || seriesUrl}" dengan db-${dbAnime._id} dari database.`);
                return `db-${dbAnime._id}`;
            }
        }
    } catch (err) {
        console.warn(`[CanonicalLookup Error]:`, err.message);
    }
    
    return currentUniqueId || null;
}

export function extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle = '') {
    let episodeSlug = '';
    let seriesSlug = '';
    let urlSlug = '';

    if (episodeUrl.includes('___neosatsu_ep___')) {
        const parts = episodeUrl.split('___neosatsu_ep___');
        const seriesPart = parts[0];
        episodeSlug = parts[1];

        if (seriesPart.startsWith('neosatsu-merge:') || seriesPart.startsWith('neosatsu-label:')) {
            const dataStr = seriesPart.split(':').slice(1).join(':'); 
            const titlePart = dataStr.split('||')[0].trim(); 
            seriesSlug = titlePart
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .trim()
                .replace(/\s+/g, '-')
                || 'neosatsu_series';
        } else {
            let cleanPart = seriesPart.replace(/\/$/, '');
            seriesSlug = cleanPart.split('/').pop() || 'neosatsu_series';
            seriesSlug = seriesSlug.replace(/\.html/g, '');
        }
    } else {
        let realEpUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realEpUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }
        const cleanUrl = realEpUrl.replace(/\/$/, '');
        episodeSlug = cleanUrl.split('/').pop() || 'uncategorized_ep';

        // Kuronime menggunakan prefix "nonton-" di URL episode (misal: /nonton-baki-dou-episode-1/)
        // Hapus prefix ini dari episodeSlug agar nama folder di Azure konsisten dengan provider lain
        if (realEpUrl.includes('kuronime.sbs') && episodeSlug.startsWith('nonton-')) {
            episodeSlug = episodeSlug.replace(/^nonton-/, '');
        }

        if (seriesUrl) {
            let realSeriesUrl = seriesUrl;
            if (seriesUrl.includes('?url=')) {
                realSeriesUrl = decodeURIComponent(seriesUrl.split('?url=')[1]);
            }
            seriesSlug = realSeriesUrl.replace(/\/$/, '').split('/').pop() || 'uncategorized';
        } else {
            seriesSlug = episodeSlug.replace(/-episode-\d+.*$/i, '').replace(/-dan-sub-indo.*$/i, '');
        }

    }
    
    urlSlug = seriesSlug || 'uncategorized';

    const rawEpSlug = episodeSlug;
    const episodeSlugsToCheck = [];
    let unifiedEpSlug = null;
    
    let epNum = null;
    if (episodeTitle) epNum = extractEpNumStrict(episodeTitle);
    if (epNum === null) epNum = extractEpNumStrict(rawEpSlug.replace(/-/g, ' '));
    
    if (epNum !== null) {
        unifiedEpSlug = `episode-${epNum}`;
        if (!episodeSlugsToCheck.includes(unifiedEpSlug)) {
            episodeSlugsToCheck.push(unifiedEpSlug);
        }
        episodeSlug = unifiedEpSlug; // use this as the primary for new uploads
    }
    
    if (rawEpSlug && !episodeSlugsToCheck.includes(rawEpSlug)) {
        episodeSlugsToCheck.push(rawEpSlug);
    }
    
    if (episodeSlugsToCheck.length === 0) {
        episodeSlugsToCheck.push('uncategorized_ep');
        episodeSlug = 'uncategorized_ep';
    }

    const slugsToCheck = [];
    let primarySlug = '';

    if (uniqueId && uniqueId.toString().trim() !== '') {
        const rawUniqueId = uniqueId.toString().trim();
        let titleSlug = '';
        
        if (seriesTitle && seriesTitle.trim().length > 0) {
            const cleanTitle = normalizeTitleForMatch(seriesTitle);
            if (cleanTitle) titleSlug = cleanTitle.replace(/\s+/g, '-');
        }

        if (titleSlug) {
            // Gabungkan ID unik dengan judul agar nama folder di Azure Storage mudah dibaca
            primarySlug = `${rawUniqueId}_${titleSlug}`;
            slugsToCheck.push(primarySlug);
            slugsToCheck.push(rawUniqueId); // Fallback ke mal id murni untuk kompatibilitas data lama
            if (!slugsToCheck.includes(titleSlug)) slugsToCheck.push(titleSlug);
        } else {
            primarySlug = rawUniqueId;
            slugsToCheck.push(primarySlug);
        }
    } else if (seriesTitle && seriesTitle.trim().length > 0) {
        const cleanTitle = normalizeTitleForMatch(seriesTitle);
        if (cleanTitle) {
            const titleSlug = cleanTitle.replace(/\s+/g, '-');
            if (titleSlug && !slugsToCheck.includes(titleSlug)) {
                slugsToCheck.push(titleSlug);
            }
        }
    }
    
    if (urlSlug && !slugsToCheck.includes(urlSlug)) {
        slugsToCheck.push(urlSlug);
    }
    
    if (!primarySlug && slugsToCheck.length > 0) {
        primarySlug = slugsToCheck[0];
    }
    if (!primarySlug) primarySlug = 'uncategorized';

    return { seriesSlug: primarySlug, episodeSlug, oldSeriesSlug: urlSlug, slugsToCheck, episodeSlugsToCheck };
}

async function getServersBasedOnUrl(episodeUrl) {
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
    } else {
        return await scrapeVideoServers(episodeUrl);
    }
}

function sourceScore(source) {
    if (source === 'Samehadaku') return 100;
    if (source === 'Otakudesu') return 50;
    if (source === 'Nanime') return 25;
    if (source === 'Kuronime') return -100; // last resort
    return 0;
}

function serverScore(host) {
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

function getResolutionGroup(serverName) {
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

async function findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, logPrefix, req = null) {
    let matchedSource = null;
    try {
        let primaryPromise = getServersBasedOnUrl(episodeUrl);
        let alternativePromise = null;
        let secondaryAlternativePromise = null;

        let primaryData = null;
        if (!episodeTitle || !seriesTitle) {
            primaryData = await primaryPromise;
            if (!episodeTitle) episodeTitle = primaryData?.judul || '';
            if (!seriesTitle && primaryData?.judul) {
                seriesTitle = primaryData.judul.replace(/\s+Episode\s+\d+.*$/i, '').replace(/\s+Sub(title)?\s+Indo(nesia)?.*$/i, '').trim();
            }
            primaryPromise = Promise.resolve(primaryData);
        }

        let urlsObj = null;
        if (req?.query?.urls) {
            try { urlsObj = JSON.parse(req.query.urls); } catch (e) {}
        }

        if (urlsObj && (urlsObj.otakudesu || urlsObj.kuronime || urlsObj.samehadaku)) {
            console.info(`${logPrefix} Menggunakan URL alternatif langsung dari metadata urls`);
            if (urlsObj.samehadaku && !episodeUrl.includes(urlsObj.samehadaku)) {
                alternativePromise = getServersBasedOnUrl(urlsObj.samehadaku).then(res => res?.servers || []).catch(() => []);
            }
            if (urlsObj.otakudesu && !episodeUrl.includes('otakudesu')) {
                let otakuUrl = urlsObj.otakudesu;
                if (otakuUrl.startsWith('/api/otakudesu/servers')) {
                    otakuUrl = new URL('http://localhost' + otakuUrl).searchParams.get('url') || otakuUrl;
                }
                const p = getOtakuServers(otakuUrl).then(res => res?.servers || []).catch(() => []);
                if (!alternativePromise) alternativePromise = p;
                else secondaryAlternativePromise = p;
            }
            if (urlsObj.kuronime && !episodeUrl.includes('kuronime')) {
                const p = getKuronimeServers(urlsObj.kuronime).then(res => res?.servers || []).catch(() => []);
                if (!alternativePromise) alternativePromise = p;
                else secondaryAlternativePromise = p;
            }
            if (urlsObj.nanime && !episodeUrl.includes('nanime')) {
                const p = getNanimeServers(urlsObj.nanime).then(res => res?.servers || []).catch(() => []);
                if (!alternativePromise) alternativePromise = p;
                else if (!secondaryAlternativePromise) secondaryAlternativePromise = p;
            }
        }

        const [resolvedPrimary, alternativeServers, secondaryAlternativeServers] = await Promise.all([
            primaryPromise,
            (alternativePromise || Promise.resolve([])).catch(err => {
                console.error(`${logPrefix} Alternative Fetch Error:`, err.message);
                return [];
            }),
            (secondaryAlternativePromise || Promise.resolve([])).catch(err => {
                console.error(`${logPrefix} Secondary Alternative Fetch Error:`, err.message);
                return [];
            })
        ]);

        const primaryServers = resolvedPrimary.servers || [];

        let primarySource = 'Samehadaku';
        if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) primarySource = 'Otakudesu';
        if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) primarySource = 'Kuronime';
        if (episodeUrl.includes('nanimeid.net') || episodeUrl.includes('/api/nanime/servers')) primarySource = 'Nanime';
        
        let altSource1 = 'Otakudesu';
        let altSource2 = 'Kuronime';
        if (primarySource === 'Otakudesu') { altSource1 = 'Samehadaku'; altSource2 = 'Kuronime'; }
        if (primarySource === 'Kuronime') { altSource1 = 'Samehadaku'; altSource2 = 'Otakudesu'; }
        if (primarySource === 'Nanime') { altSource1 = 'Samehadaku'; altSource2 = 'Otakudesu'; }

        const taggedPrimary = primaryServers.map(s => ({ ...s, source: primarySource }));
        const taggedAlternative1 = (alternativeServers || []).map(s => ({ ...s, source: altSource1 }));
        const taggedAlternative2 = (secondaryAlternativeServers || []).map(s => ({ ...s, source: altSource2 }));

        const servers = [...taggedPrimary, ...taggedAlternative1, ...taggedAlternative2];

        if (servers.length === 0) {
            return { matchedSource: null, error: 'Tidak ada server download/streaming yang ditemukan di halaman episode.' };
        }

        const groups = { 1080: [], 720: [], 480: [], 360: [] };
        for (const srv of servers) {
            if (srv.namaHost && srv.namaHost.toLowerCase().includes('mega') && isMegaBlacklisted()) {
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

                    const sScoreDiff = sourceScore(b.source) - sourceScore(a.source);
                    if (sScoreDiff !== 0) return sScoreDiff;

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
                        const finalHeaders = { ...(extracted.headers || {}), ...(srv.headers || {}) };
                        try {
                            await checkRangeSupport(extracted.url, finalHeaders);
                            matchedSource = { url: extracted.url, headers: finalHeaders };
                            console.info(`${logPrefix} ✓ Menemukan source video (${resVal}p) dari ${srv.source} [${srv.namaHost}]`);
                            break;
                        } catch (pingErr) {
                            if (pingErr.message === 'HTTP_429_LIMIT') {
                                console.warn(`${logPrefix} ${srv.namaHost} terkena limit kuota (429), lompat ke server berikutnya...`);
                                continue;
                            }
                            throw pingErr;
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

function isCurrentlyExtracting(checkSlugs, episodeSlugs) {
    const sList = Array.isArray(checkSlugs) ? checkSlugs : [checkSlugs].filter(Boolean);
    const eList = Array.isArray(episodeSlugs) ? episodeSlugs : [episodeSlugs].filter(Boolean);
    for (const s of sList) {
        for (const e of eList) {
            if (activeExtractions.has(getBlobPath(s, e))) return true;
        }
    }
    return false;
}

function addActiveExtractions(checkSlugs, episodeSlugs) {
    const sList = Array.isArray(checkSlugs) ? checkSlugs : [checkSlugs].filter(Boolean);
    const eList = Array.isArray(episodeSlugs) ? episodeSlugs : [episodeSlugs].filter(Boolean);
    for (const s of sList) {
        for (const e of eList) {
            activeExtractions.add(getBlobPath(s, e));
        }
    }
}

function removeActiveExtractions(checkSlugs, episodeSlugs) {
    const sList = Array.isArray(checkSlugs) ? checkSlugs : [checkSlugs].filter(Boolean);
    const eList = Array.isArray(episodeSlugs) ? episodeSlugs : [episodeSlugs].filter(Boolean);
    for (const s of sList) {
        for (const e of eList) {
            activeExtractions.delete(getBlobPath(s, e));
        }
    }
}

/**
 * Prefetch satu episode tertentu ke Azure Blob.
 * Return true jika berhasil memulai upload, false jika sudah ada/skip.
 */
export async function prefetchOneEpisode(seriesSlug, episodeUrl, seriesTitle, source = 'player', oldSeriesSlug = null, slugsToCheck = null, episodeTitle = '', uniqueId = null, customSignal = null) {
    uniqueId = await resolveCanonicalUniqueId(null, episodeUrl, seriesTitle, uniqueId);
    // Global Slug Normalization: selalu teruskan seriesTitle & uniqueId agar slugsToCheck dan episodeSlugsToCheck konsisten 100% di seluruh pipeline
    const { seriesSlug: extractedSeriesSlug, episodeSlug, oldSeriesSlug: extractedOldSlug, slugsToCheck: extractedSlugs, episodeSlugsToCheck } = extractSlugs(episodeUrl, null, seriesTitle, uniqueId, episodeTitle); 
    
    const checkSlugs = slugsToCheck && slugsToCheck.length > 0 ? slugsToCheck : (extractedSlugs && extractedSlugs.length > 0 ? extractedSlugs : [seriesSlug, oldSeriesSlug, extractedSeriesSlug, extractedOldSlug].filter(Boolean));
    const checkInfo = await checkUploadStatusWithFallback(checkSlugs, episodeSlugsToCheck);
    const status = checkInfo.status;
    const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
    const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;
    
    const logPrefix = source === 'queue' ? '[Queue]' : '[Prefetch]';
    const activeSignal = customSignal || (source === 'prefetch' ? prefetchAbortController.signal : null);
    
    // Jika lewat queue, kita abaikan status FAILED agar bisa di-retry
    if (status === 'READY' || status === 'UPLOADING' || (status === 'FAILED' && source !== 'queue')) {
        return { success: false, reason: 'Already processing or failed' };
    }

    if (isCurrentlyExtracting(checkSlugs, episodeSlugsToCheck)) {
        console.info(`${logPrefix} Skip ${episodeSlug} — sedang diekstrak/diunggah`);
        return { success: false, reason: 'Already extracting' };
    }

    console.info(`${logPrefix} Memulai proses untuk: ${episodeSlug}`);
    addActiveExtractions(checkSlugs, episodeSlugsToCheck);
    let matchedSource = null;

    try {
        const maxAttempts = 5;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                if (activeSignal && activeSignal.aborted) {
                    console.info(`${logPrefix} Dibatalkan oleh pengguna sebelum percobaan ${attempt}.`);
                    removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
                    return { success: false, reason: 'UPLOAD_CANCELLED' };
                }

                const attemptPrefix = attempt > 1 ? `${logPrefix} [Retry ${attempt}/${maxAttempts}]` : logPrefix;
                const result = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, attemptPrefix);
                matchedSource = result.matchedSource;
                
                if (activeSignal && activeSignal.aborted) {
                    console.info(`${attemptPrefix} Dibatalkan oleh pengguna saat mencari source video.`);
                    removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
                    return { success: false, reason: 'UPLOAD_CANCELLED' };
                }

                if (!matchedSource) {
                    console.info(`${attemptPrefix} Tidak ada server untuk: ${episodeSlug}`);
                    if (attempt === maxAttempts) {
                        markUploadFailed(activeSlug, episodeSlug);
                        removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
                        return { success: false, reason: result.error || 'Semua server gagal atau limit.' };
                    }
                    lastError = new Error(result.error || 'Semua server gagal atau limit.');
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }

                proxyCache.set(`prefetch_src_${activeSlug}_${episodeSlug}`, matchedSource);
                await uploadStream(matchedSource.url, matchedSource.headers, activeSlug, episodeSlug, source);
                proxyCache.del(`prefetch_src_${activeSlug}_${episodeSlug}`);
                removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
                return { success: true };
            } catch (err) {
                proxyCache.del(`prefetch_src_${activeSlug}_${episodeSlug}`);
                const isCanceled = err.message === 'UPLOAD_CANCELLED' || err.message?.toLowerCase().includes('cancel') || err.code === 'ERR_CANCELED' || err.name === 'AbortError' || (activeSignal && activeSignal.aborted);
                if (isCanceled) {
                    console.info(`${logPrefix} Upload dibatalkan oleh pengguna (cancel/exit app). Menghentikan proses retry.`);
                    removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
                    return { success: false, reason: 'UPLOAD_CANCELLED' };
                }
                console.warn(`${logPrefix} Upload/Ekstraksi gagal pada percobaan ${attempt}/${maxAttempts} (${err.message}). Mencoba server/web alternatif lain...`);
                lastError = err;
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }

        markUploadFailed(activeSlug, episodeSlug);
        removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
        throw lastError || new Error('All prefetch retry attempts failed.');
    } catch (err) {
        markUploadFailed(activeSlug, episodeSlug);
        removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
        throw err;
    }
}

const activePrefetchLoops = new Set();

/**
 * Prefetch sliding window — unduh episode dalam `upcomingUrls` satu per satu
 * secara sekuensial dengan jeda antar episode.
 * Jika ada upload Mega yang sedang berjalan, tunggu dulu.
 */
async function triggerPrefetchWindow(seriesSlug, upcomingUrls, seriesTitle, slugsToCheck = null, uniqueId = null) {
    if (!upcomingUrls || upcomingUrls.length === 0) return;

    const validUrls = upcomingUrls.filter(Boolean);
    if (validUrls.length === 0) return;

    const cleanSeries = seriesSlug.replace(/^mal-\d+_/, '');
    const loopKey = `${cleanSeries}-${validUrls.join(',')}`;
    if (activePrefetchLoops.has(loopKey)) return;
    activePrefetchLoops.add(loopKey);

    const activeSignal = prefetchAbortController.signal;

    try {

    for (const epUrl of validUrls) {
        try {
            // Global Slug Normalization: teruskan seriesTitle & uniqueId untuk pencocokan kunci yang konsisten
            const { slugsToCheck: extractedSlugs, episodeSlug, episodeSlugsToCheck } = extractSlugs(epUrl, null, seriesTitle, uniqueId, null);
            const checkSlugs = slugsToCheck && slugsToCheck.length > 0 ? slugsToCheck : (extractedSlugs && extractedSlugs.length > 0 ? extractedSlugs : [seriesSlug]);
            const checkInfo = await checkUploadStatusWithFallback(checkSlugs, episodeSlugsToCheck);
            const status = checkInfo.status;

            if (status === 'READY' || status === 'FAILED') {
                // Sudah done atau sudah gagal — skip
                console.info(`[PrefetchWindow] ✓ Skip prefetch untuk ${episodeSlug} — status sudah ${status} di Azure.`);
                continue;
            }

            if (status === 'UPLOADING') {
                // Sedang upload, tunggu dahulu sebelum episode berikutnya
                console.info(`[PrefetchWindow] ${episodeSlug} sedang UPLOADING, tunggu sebelum lanjut ke episode berikutnya...`);
                await new Promise(r => setTimeout(r, 45000)); // Tunggu 45 detik
                continue;
            }

            // Jika ada upload aktif lainnya di series ini, tunggu dulu sebelum mulai prefetch
            let activeUploadExists = hasActiveUploadForSeries(seriesSlug);
            let globalUploadCount = getActiveUploadCount();
            let waitAttempts = 0;
            const maxWaitAttempts = 30; // Maksimal tunggu 5 menit (30 x 10 detik) untuk mencegah Thread Blocking abadi / zombie process

            while ((activeUploadExists || globalUploadCount >= 3) && waitAttempts < maxWaitAttempts) {
                if (activeSignal.aborted) {
                    console.info(`[PrefetchWindow] Dibatalkan oleh pengguna saat menunggu antrean untuk ${episodeSlug}`);
                    return;
                }

                if (activeUploadExists) {
                    console.info(`[PrefetchWindow] Series ${seriesSlug} masih memiliki upload yang berjalan. Menunda prefetch ${episodeSlug}... (${waitAttempts + 1}/${maxWaitAttempts})`);
                } else if (globalUploadCount >= 3) {
                    console.info(`[PrefetchWindow] VPS sedang sibuk (ada ${globalUploadCount} upload berjalan). Menunda prefetch ${episodeSlug}... (${waitAttempts + 1}/${maxWaitAttempts})`);
                }

                await new Promise(r => setTimeout(r, 10000)); // Cek setiap 10 detik
                waitAttempts++;

                activeUploadExists = hasActiveUploadForSeries(seriesSlug);
                globalUploadCount = getActiveUploadCount();
            }

            if (waitAttempts >= maxWaitAttempts && (activeUploadExists || globalUploadCount >= 3)) {
                console.warn(`[PrefetchWindow] Timeout menunggu antrean untuk ${episodeSlug} setelah ${maxWaitAttempts * 10} detik. Melewati episode ini.`);
                continue;
            }

            if (activeSignal.aborted) return;

            const res = await prefetchOneEpisode(seriesSlug, epUrl, seriesTitle, 'prefetch', null, slugsToCheck, '', uniqueId, activeSignal);
            if ((res && res.reason === 'UPLOAD_CANCELLED') || activeSignal.aborted) {
                console.info(`[PrefetchWindow] Dibatalkan oleh pengguna. Menghentikan seluruh antrean prefetch window.`);
                return;
            }

            // Jeda antar episode untuk mencegah ETOOMANY dari Mega
            if (validUrls.indexOf(epUrl) < validUrls.length - 1) {
                console.info(`[PrefetchWindow] Jeda 30 detik sebelum prefetch episode berikutnya...`);
                await new Promise(r => setTimeout(r, 30000));
            }
        } catch (err) {
            const isCanceled = err.message === 'UPLOAD_CANCELLED' || err.message?.toLowerCase().includes('cancel') || err.code === 'ERR_CANCELED' || err.name === 'AbortError' || activeSignal.aborted;
            if (isCanceled) {
                console.info(`[PrefetchWindow] Dibatalkan oleh pengguna. Menghentikan seluruh antrean prefetch window.`);
                return;
            }
            console.error(`[PrefetchWindow Error] ${epUrl}:`, err.message);
        }
    }
    } finally {
        activePrefetchLoops.delete(loopKey);
    }
}



// ============================================================
// RUTE 5: GET /api/extract-video?url=EMBED_URL
// ============================================================
router.get('/api/extract-video', async (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).json({ success: false, error: "Parameter 'url' wajib diisi!" });

    try {
        const data = await extractVideoUrl(embedUrl, req);

        if (!data || !data.url) {
            console.info(`[Extract-Video] Ekstraksi gagal untuk: ${embedUrl}`);
            return res.json({ success: false, message: 'Ekstraksi URL video gagal. Sistem hanya mendukung pemutaran MP4 (Blob).' });
        }

        let finalUrl = data.url;

        if (data?.headers?.token && data?.url) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            finalUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(data.url)}&token=${encodeURIComponent(data.headers.token)}&referer=${encodeURIComponent(data.headers.Referer || '')}`;
        } else if ((embedUrl.includes('filedon') || embedUrl.includes('pucuk') || embedUrl.includes('pixeldrain.com') || embedUrl.includes('filemoon') || embedUrl.includes('filelions') || embedUrl.includes('moonplayer')) && data?.url) {
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
// RUTE Baru: GET /api/smart-play
// Parameter: episodeUrl (wajib), seriesUrl, nextEpisodeUrl
// ============================================================
router.get('/api/smart-play', async (req, res) => {
    let { episodeUrl, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle, uniqueId } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

    uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);

    // Susun window prefetch: [N+1, N+2] — hanya yang ada nilainya
    const prefetchWindow = [nextEpisodeUrl].filter(Boolean);

    try {
        const { seriesSlug, episodeSlug, oldSeriesSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);

        const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        const status = checkInfo.status;
        const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
        const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

        if (status === 'READY') {
            if (prefetchWindow.length > 0) {
                // Selalu prefetch ke folder baru (seriesSlug)
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
            }
            return res.json({
                success: true,
                status: 'READY',
                url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
            });
        }

        if (status === 'UPLOADING') {
            if (prefetchWindow.length > 0) {
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
            }

            let cachedProxyUrl = proxyCache.get(`proxy_${seriesSlug}_${episodeSlug}`);
            if (!cachedProxyUrl && proxyCache.has(`prefetch_src_${seriesSlug}_${episodeSlug}`)) {
                const src = proxyCache.get(`prefetch_src_${seriesSlug}_${episodeSlug}`);
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                if (src.headers && src.headers.token) {
                    cachedProxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(src.url)}&token=${encodeURIComponent(src.headers.token)}&referer=${encodeURIComponent(src.headers.Referer || '')}`;
                } else {
                    cachedProxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(src.url)}`;
                }
            }

            if (cachedProxyUrl) {
                return res.json({
                    success: true,
                    status: 'UPLOADING',
                    // url dihapus agar player tidak memutar proxy stream dan tetap menampilkan progress upload
                    message: 'Video sedang dialirkan ke Azure Blob (Proxy dimatikan agar progress terlihat).'
                });
            }

            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Video sedang dialirkan ke Azure Blob.'
            });
        }

        if (status === 'FAILED') {
            return res.json({
                success: true,
                status: 'FAILED',
                message: 'Ekstraksi video gagal sebelumnya. Menggunakan fallback server.'
            });
        }

        if (isCurrentlyExtracting(slugsToCheck, episodeSlugsToCheck)) {
            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Video sedang diekstrak di request lain.'
            });
        }

        // Status is FAILED or null -> Start extraction and upload process
        console.info(`[Smart-Play] Mulai ekstraksi server untuk: ${episodeUrl}`);

        addActiveExtractions(slugsToCheck, episodeSlugsToCheck);
        let matchedSource = null;

        try {
            const result = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, '[Smart-Play]', req);
            matchedSource = result.matchedSource;

            if (!matchedSource) {
                removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                markUploadFailed(seriesSlug, episodeSlug);
                return res.status(404).json({
                    success: false,
                    status: 'FAILED',
                    message: result.error || 'Tidak ada server download/streaming yang ditemukan di halaman episode.'
                });
            }
        } catch (err) {
            removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
            throw err;
        }

        if (matchedSource) {
            // Start upload in background with 5x retry loop across candidate servers
            const runBackgroundUpload = async () => {
                const maxAttempts = 5;
                let currentSource = matchedSource;
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        if (attempt > 1) {
                            console.info(`[Smart-Play] Mencoba ulang upload latar belakang (${attempt}/${maxAttempts})...`);
                            const res = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, `[Smart-Play Retry ${attempt}/${maxAttempts}]`, req);
                            currentSource = res.matchedSource;
                            if (!currentSource) {
                                throw new Error(res.error || 'Tidak ada server cadangan lain.');
                            }
                        }
                        await uploadStream(currentSource.url, currentSource.headers, seriesSlug, episodeSlug, 'player');
                        removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                        if (prefetchWindow.length > 0) {
                            console.info(`[Smart-Play] Upload selesai. Memulai prefetch window [${prefetchWindow.length} episode]...`);
                            triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck, uniqueId);
                        }
                        return;
                    } catch (err) {
                        const isCanceled = err.message === 'UPLOAD_CANCELLED' || err.message?.toLowerCase().includes('cancel') || err.code === 'ERR_CANCELED' || err.name === 'AbortError' || prefetchAbortController.signal.aborted;
                        if (isCanceled) {
                            console.info(`[Smart-Play] Upload dibatalkan oleh pengguna (cancel/exit app). Menghentikan proses retry.`);
                            removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                            return;
                        }
                        console.error(`[Smart-Play] Upload latar belakang gagal pada percobaan ${attempt}/${maxAttempts}:`, err.message);
                        if (attempt === maxAttempts) {
                            removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
                            markUploadFailed(seriesSlug, episodeSlug);
                        } else {
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                }
            };
            runBackgroundUpload();

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            let proxyUrl = matchedSource.url;
            if (matchedSource.headers && matchedSource.headers.token) {
                proxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(matchedSource.url)}&token=${encodeURIComponent(matchedSource.headers.token)}&referer=${encodeURIComponent(matchedSource.headers.Referer || '')}`;
            } else if (!matchedSource.url.includes('.m3u8')) {
                proxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(matchedSource.url)}`;
            }

            // Simpan proxy URL sementara ke cache (opsional)
            proxyCache.set(`proxy_${seriesSlug}_${episodeSlug}`, proxyUrl);

            return res.json({
                success: true,
                status: 'UPLOADING',
                // url dihapus agar player tidak memutar proxy stream dan tetap menampilkan progress upload
                message: 'Video sedang dialirkan ke Azure Blob (Proxy dimatikan agar progress terlihat).'
            });
        } else {
            markUploadFailed(seriesSlug, episodeSlug);
            return res.status(404).json({
                success: false,
                status: 'FAILED',
                message: 'Tidak ada server MP4 atau M3U8 yang didukung untuk resolusi yang tersedia.'
            });
        }

    } catch (err) {
        console.error(`[Smart-Play Error] URL: ${episodeUrl} | STACK:`, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================================
// POST /api/cancel-uploads
// ============================================================
router.post('/api/cancel-uploads', (req, res) => {
    try {
        prefetchAbortController.abort();
        prefetchAbortController = new AbortController();
        const count = cancelAllUploads('player') + cancelAllUploads('prefetch');
        res.json({ success: true, message: `Berhasil membatalkan ${count} upload aktif.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// GET /api/upload-status
// ============================================================
router.get('/api/upload-status', async (req, res) => {
    try {
        let { episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle } = req.query;
        if (!episodeUrl) return res.status(400).json({ success: false, message: "URL required" });
        
        uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);
        const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
        const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
        const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

        const progressMessage = getUploadProgress(activeSlug, activeEpSlug);
        res.json({ success: true, progressMessage });
    } catch (e) {
        console.error(`[Smart-Play Error]:`, e.message);
        return res.status(500).json({ success: false, status: 'FAILED', message: e.message });
    }
});

// Endpoint untuk membatalkan upload secara eksplisit dari client
router.all(['/api/cancel-stream', '/cancel-stream'], express.json(), async (req, res) => {
    const body = req.body || {};
    const query = req.query || {};
    let url = body.url || body.episodeUrl || query.url || query.episodeUrl;
    let seriesUrl = body.seriesUrl || query.seriesUrl;
    let seriesTitle = body.seriesTitle || query.seriesTitle;
    let uniqueId = body.uniqueId || query.uniqueId;
    let episodeTitle = body.episodeTitle || query.episodeTitle;

    if (!url) return res.json({ success: false });
    
    uniqueId = await resolveCanonicalUniqueId(seriesUrl, url, seriesTitle, uniqueId);
    const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(url, seriesUrl, seriesTitle, uniqueId, episodeTitle);
    const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
    const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
    const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

    const blobPath = getBlobPath(activeSlug, activeEpSlug);
    
    console.info(`[Smart-Play] Eksplisit cancel dari client untuk: ${activeEpSlug}`);
    cancelUpload(activeSlug, activeEpSlug);
    removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
    
    // Batalkan juga prefetch yang sedang berjalan karena user sudah keluar dari player
    prefetchAbortController.abort();
    prefetchAbortController = new AbortController();
    cancelAllUploads('prefetch');
    
    return res.json({ success: true });
});

// POST / GET /api/report-broken
// Menghapus blob rusak/tanpa sub dari cloud & me-reset status agar player bisa beralih ke server alternatif
router.all(['/api/report-broken', '/report-broken'], express.json(), async (req, res) => {
    try {
        const body = req.body || {};
        const query = req.query || {};
        let url = body.url || body.episodeUrl || body.embedUrl || body.videoUrl || query.url || query.episodeUrl || query.embedUrl || query.videoUrl;
        let seriesUrl = body.seriesUrl || query.seriesUrl;
        let seriesTitle = body.seriesTitle || query.seriesTitle;
        let uniqueId = body.uniqueId || query.uniqueId;
        let episodeTitle = body.episodeTitle || query.episodeTitle;
        let currentServer = body.currentServer || query.currentServer;

        if (!url) {
            console.warn(`[Report Broken] ⚠️ Gagal: Laporan diterima namun parameter URL kosong! Body: ${JSON.stringify(body)} | Query: ${JSON.stringify(query)}`);
            return res.status(400).json({ success: false, message: "URL diperlukan" });
        }

        uniqueId = await resolveCanonicalUniqueId(seriesUrl, url, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(url, seriesUrl, seriesTitle, uniqueId, episodeTitle);
        
        console.warn(`[Report Broken] ⚠️ Laporan dari pengguna untuk video: "${episodeTitle || url}" (Server: ${currentServer || 'Unknown'})`);
        
        // Hapus blob dari Azure dan bersihkan cache agar upload baru dari server lain bisa berjalan
        await invalidateAndDeleteBlob(slugsToCheck, episodeSlugsToCheck);
        removeActiveExtractions(slugsToCheck, episodeSlugsToCheck);
        
        // Batalkan juga prefetch yang sedang berjalan agar tidak membuang resource VPS
        prefetchAbortController.abort();
        prefetchAbortController = new AbortController();
        cancelAllUploads('prefetch');
        
        res.json({ success: true, message: "Video rusak/tanpa subtitle berhasil dihapus dari cloud. Silakan ganti server." });
    } catch (e) {
        console.error(`[Report Broken Error]:`, e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// RUTE QUEUE: Background Download Manager
// ============================================================

router.post('/api/queue/add', express.json(), async (req, res) => {
    try {
        let { episodeUrl, seriesUrl, seriesTitle, episodeTitle, uniqueId } = req.body;
        if (!episodeUrl) return res.status(400).json({ success: false, error: "episodeUrl diperlukan" });
        
        uniqueId = await resolveCanonicalUniqueId(seriesUrl, episodeUrl, seriesTitle, uniqueId);
        const { seriesSlug, episodeSlug } = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle);
        
        const item = await backgroundQueue.add(episodeUrl, seriesUrl, seriesSlug, seriesTitle, episodeTitle, uniqueId);
        res.json({ success: true, item });
    } catch (e) {
        console.error(`[Queue Add Error]:`, e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/queue/prioritize', express.json(), async (req, res) => {
    try {
        const { id } = req.body;
        await backgroundQueue.prioritize(id);
        res.json({ success: true });
    } catch (e) {
        console.error(`[Queue Prioritize Error]:`, e.message);
        res.status(500).json({ success: false });
    }
});

router.post('/api/queue/cancel', express.json(), async (req, res) => {
    const { id } = req.body;
    
    try {
        const task = await QueueTask.findOne({ id });
        if (task && task.status === 'UPLOADING') {
            const { seriesSlug, episodeSlug } = extractSlugs(task.episodeUrl, task.seriesUrl, task.seriesTitle, task.uniqueId, task.episodeTitle);
            
            if (seriesSlug && episodeSlug) {
                cancelUpload(seriesSlug, episodeSlug);
                console.info(`[Queue] Upload dibatalkan untuk ${episodeSlug}`);
            }
        }
        await backgroundQueue.cancel(id);
        res.json({ success: true });
    } catch (e) {
        console.error(`[Queue] Gagal membatalkan task ${id}:`, e.message);
        res.status(500).json({ success: false });
    }
});

router.get('/api/queue/status', async (req, res) => {
    try {
        const queueItems = await backgroundQueue.getStatus();
        
        const updatedItems = await Promise.all(queueItems.map(async (item) => {
            if (item.status === 'UPLOADING') {
                const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
                const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
                const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
                const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

                item.progress = getUploadProgress(activeSlug, activeEpSlug);
            }
            return item;
        }));

        res.json({ success: true, queue: updatedItems });
    } catch (e) {
        console.error(`[Queue Status Error]:`, e.message);
        res.status(500).json({ success: false, queue: [] });
    }
});

router.get('/api/queue/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendQueueUpdate = async () => {
        const queueItems = await backgroundQueue.getStatus();
        
        // Update real-time progress untuk item yang UPLOADING
        const updatedItems = await Promise.all(queueItems.map(async (item) => {
            if (item.status === 'UPLOADING') {
                const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
                const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
                const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
                const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

                item.progress = getUploadProgress(activeSlug, activeEpSlug);
            }
            return item;
        }));

        res.write(`data: ${JSON.stringify({ success: true, queue: updatedItems })}\n\n`);
    };

    // Kirim data langsung saat koneksi dibuka
    sendQueueUpdate();

    // Kirim update setiap 1.5 detik
    const interval = setInterval(sendQueueUpdate, 1500);

    req.on('close', () => {
        clearInterval(interval);
    });
});

export default router;
