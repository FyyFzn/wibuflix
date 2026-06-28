import express from 'express';
import { extractVideoUrl, scrapeVideoServers, resolveSingleServer } from '../services/extractors/videoExtractor.js';
import { getAlternativeServers as getAlternativeServersSamehadaku } from '../controllers/samehadakuController.js';
import { checkUploadStatus, checkUploadStatusWithFallback, uploadStream, getBlobPath, getBlobUrl, markUploadFailed, hasActiveUploadForSeries, getActiveUploadCount, getUploadProgress, cancelUpload, cancelAllUploads, checkRangeSupport, isMegaBlacklisted } from '../utils/azureUploader.js';
import { normalizeTitleForMatch, extractEpNumStrict } from '../utils/stringUtils.js';
import { getNeosatsuServers } from '../controllers/neosatsuController.js';
import { getServersInternal as getOtakuServers, getAlternativeServers as getOtakuAlternativeServers } from '../controllers/otakudesuController.js';
import { getKuronimeServers, getAlternativeServers as getKuronimeAlternativeServers } from '../controllers/kuronimeController.js';
import { backgroundQueue } from '../utils/queueManager.js';
import QueueTask from '../models/QueueTask.js';

// Setup background queue processor
backgroundQueue.setProcessor(async (item) => {
    // Extract slugs with uniqueId to get full fallback slugsToCheck array
    const { episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(item.episodeUrl, item.seriesUrl, item.seriesTitle, item.uniqueId, item.episodeTitle);
    
    // Cek apakah sudah selesai atau sedang di proses oleh request lain
    const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
    if (checkInfo.status === 'READY') {
        console.info(`[Queue] ${item.episodeTitle} sudah tersedia di server. Langsung diselesaikan.`);
        return; // Otomatis menjadi COMPLETED
    }
    if (checkInfo.status === 'UPLOADING') {
        console.info(`[Queue] ${item.episodeTitle} sedang diunggah oleh proses lain. Melepas dari antrean.`);
        return; // Otomatis menjadi COMPLETED di antrean (player akan handle progressnya)
    }
    
    // Jalankan prefetchOneEpisode dengan source 'queue' dan bawa slugsToCheck
    const result = await prefetchOneEpisode(item.seriesSlug, item.episodeUrl, item.seriesTitle, 'queue', null, slugsToCheck);
    if (!result.success) {
        // Jika gagal karena error beneran, lemparkan error untuk trigger retry
        if (result.reason !== 'Already processing or failed') {
             throw new Error(result.reason || 'Prefetch failed');
        }
    }
});

const router = express.Router();
const activeExtractions = new Set();
let prefetchAbortController = new AbortController();

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

        if (seriesUrl) {
            let realSeriesUrl = seriesUrl;
            if (seriesUrl.includes('?url=')) {
                realSeriesUrl = decodeURIComponent(seriesUrl.split('?url=')[1]);
            }
            seriesSlug = realSeriesUrl.replace(/\/$/, '').split('/').pop() || 'uncategorized';
        } else {
            seriesSlug = episodeSlug.replace(/-episode-\d+.*$/i, '').replace(/-dan-sub-indo.*$/i, '');
            if (episodeUrl.includes('kuronime.sbs') && seriesSlug.startsWith('nonton-')) {
                seriesSlug = seriesSlug.replace(/^nonton-/, '');
            }
        }

    }
    
    urlSlug = seriesSlug || 'uncategorized';

    const rawEpSlug = episodeSlug;
    const episodeSlugsToCheck = [];
    let unifiedEpSlug = null;
    
    if (uniqueId && uniqueId.toString().trim() !== '') {
        let epNum = null;
        if (episodeTitle) epNum = extractEpNumStrict(episodeTitle);
        if (epNum === null) epNum = extractEpNumStrict(rawEpSlug.replace(/-/g, ' '));
        
        if (epNum !== null) {
            unifiedEpSlug = `episode-${epNum}`;
            episodeSlugsToCheck.push(unifiedEpSlug);
            episodeSlug = unifiedEpSlug; // use this as the primary for new uploads
        }
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
    } else {
        return await scrapeVideoServers(episodeUrl);
    }
}

function serverScore(host) {
    if (!host) return 0;
    const h = host.toLowerCase();
    if (h.includes('mega')) {
        if (isMegaBlacklisted()) return -50;
        return 100;
    }
    if (h.includes('wibufile')) return 90;
    if (h.includes('filedon') || h.includes('filemoon') || h.includes('filelions')) return 80;
    if (h.includes('mediafire')) return 75;
    if (h.includes('pixeldrain')) return 70;
    if (h.includes('acefile')) return 60;
    if (h.includes('vidhide')) return 50;
    if (h.includes('kraken')) return -100; // super lambat, last resort
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
        let alternativePromise = Promise.resolve([]);
        let secondaryAlternativePromise = Promise.resolve([]);

        let primaryData = null;
        if (!episodeTitle) {
            primaryData = await primaryPromise;
            episodeTitle = primaryData.judul || '';
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
                if (alternativePromise === Promise.resolve([])) alternativePromise = p;
                else secondaryAlternativePromise = p;
            }
            if (urlsObj.kuronime && !episodeUrl.includes('kuronime')) {
                const p = getKuronimeServers(urlsObj.kuronime).then(res => res?.servers || []).catch(() => []);
                if (alternativePromise === Promise.resolve([])) alternativePromise = p;
                else secondaryAlternativePromise = p;
            }
        } else if (seriesTitle && episodeTitle && !episodeUrl.includes('___neosatsu_ep___')) {
            try {
                if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) {
                    console.info(`${logPrefix} Pencarian alternatif di Samehadaku & Kuronime untuk: "${seriesTitle}" - "${episodeTitle}"`);
                    alternativePromise = getAlternativeServersSamehadaku(seriesTitle, episodeTitle);
                    secondaryAlternativePromise = getKuronimeAlternativeServers(seriesTitle, episodeTitle);
                } else if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) {
                    console.info(`${logPrefix} Pencarian alternatif di Samehadaku & Otakudesu untuk: "${seriesTitle}" - "${episodeTitle}"`);
                    alternativePromise = getAlternativeServersSamehadaku(seriesTitle, episodeTitle);
                    secondaryAlternativePromise = getOtakuAlternativeServers(seriesTitle, episodeTitle, episodeUrl);
                } else {
                    console.info(`${logPrefix} Pencarian alternatif di Otakudesu & Kuronime untuk: "${seriesTitle}" - "${episodeTitle}"`);
                    alternativePromise = getOtakuAlternativeServers(seriesTitle, episodeTitle, episodeUrl);
                    secondaryAlternativePromise = getKuronimeAlternativeServers(seriesTitle, episodeTitle);
                }
            } catch (err) {
                console.error(`${logPrefix} Alternative Fetch Error:`, err.message);
            }
        }

        const [resolvedPrimary, alternativeServers, secondaryAlternativeServers] = await Promise.all([
            primaryPromise,
            alternativePromise.catch(err => {
                console.error(`${logPrefix} Alternative Fetch Error:`, err.message);
                return [];
            }),
            secondaryAlternativePromise.catch(err => {
                console.error(`${logPrefix} Secondary Alternative Fetch Error:`, err.message);
                return [];
            })
        ]);

        const primaryServers = resolvedPrimary.servers || [];

        let primarySource = 'Samehadaku';
        if (episodeUrl.includes('otakudesu') || episodeUrl.includes('/api/otakudesu/servers')) primarySource = 'Otakudesu';
        if (episodeUrl.includes('kuronime.sbs') || episodeUrl.includes('/api/kuronime/servers')) primarySource = 'Kuronime';
        
        let altSource1 = 'Otakudesu';
        let altSource2 = 'Kuronime';
        if (primarySource === 'Otakudesu') { altSource1 = 'Samehadaku'; altSource2 = 'Kuronime'; }
        if (primarySource === 'Kuronime') { altSource1 = 'Samehadaku'; altSource2 = 'Otakudesu'; }

        const taggedPrimary = primaryServers.map(s => ({ ...s, source: primarySource }));
        const taggedAlternative1 = (alternativeServers || []).map(s => ({ ...s, source: altSource1 }));
        const taggedAlternative2 = (secondaryAlternativeServers || []).map(s => ({ ...s, source: altSource2 }));

        const servers = [...taggedPrimary, ...taggedAlternative1, ...taggedAlternative2];

        if (servers.length === 0) {
            return { matchedSource: null, error: 'Tidak ada server download/streaming yang ditemukan di halaman episode.' };
        }

        const groups = { 1080: [], 720: [], 480: [], 360: [] };
        for (const srv of servers) {
            const resGroup = getResolutionGroup(srv.nama);
            if (resGroup && groups[resGroup]) groups[resGroup].push(srv);
        }

        for (const resVal of [1080, 720, 480, 360]) {
            if (groups[resVal].length > 0) {
                groups[resVal].sort((a, b) => {
                    const aIsM3u8 = a.type === 'direct' && a.iframeUrl && a.iframeUrl.includes('.m3u8') ? 1 : 0;
                    const bIsM3u8 = b.type === 'direct' && b.iframeUrl && b.iframeUrl.includes('.m3u8') ? 1 : 0;
                    if (aIsM3u8 !== bIsM3u8) return bIsM3u8 - aIsM3u8;
                    return serverScore(b.namaHost) - serverScore(a.namaHost);
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

/**
 * Prefetch satu episode tertentu ke Azure Blob.
 * Return true jika berhasil memulai upload, false jika sudah ada/skip.
 */
export async function prefetchOneEpisode(seriesSlug, episodeUrl, seriesTitle, source = 'player', oldSeriesSlug = null, slugsToCheck = null) {
    // For prefetch from SmartPlay window, episodeTitle is not passed, but rawEpSlug fallback still works
    const { episodeSlug, episodeSlugsToCheck } = extractSlugs(episodeUrl, null, null, null, null); 
    
    const checkSlugs = slugsToCheck && slugsToCheck.length > 0 ? slugsToCheck : [seriesSlug, oldSeriesSlug].filter(Boolean);
    const checkInfo = await checkUploadStatusWithFallback(checkSlugs, episodeSlugsToCheck);
    const status = checkInfo.status;
    const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
    const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;
    
    const blobPath = getBlobPath(activeSlug, activeEpSlug);
    const logPrefix = source === 'queue' ? '[Queue]' : '[Prefetch]';
    
    // Jika lewat queue, kita abaikan status FAILED agar bisa di-retry
    if (status === 'READY' || status === 'UPLOADING' || (status === 'FAILED' && source !== 'queue')) {
        return { success: false, reason: 'Already processing or failed' };
    }

    if (activeExtractions.has(blobPath)) {
        console.info(`${logPrefix} Skip ${episodeSlug} — sedang diekstrak/diunggah`);
        return { success: false, reason: 'Already extracting' };
    }

    console.info(`${logPrefix} Memulai proses untuk: ${episodeSlug}`);
    activeExtractions.add(blobPath);
    let matchedSource = null;

    try {
        const result = await findBestVideoSource(episodeUrl, seriesTitle, '', logPrefix);
        matchedSource = result.matchedSource;
        
        if (!matchedSource) {
            console.info(`${logPrefix} Tidak ada server untuk: ${episodeSlug}`);
            markUploadFailed(activeSlug, episodeSlug);
            activeExtractions.delete(blobPath);
            return { success: false, reason: result.error || 'Semua server gagal atau limit.' };
        }

        global[`prefetch_src_${activeSlug}_${episodeSlug}`] = matchedSource;
        await uploadStream(matchedSource.url, matchedSource.headers, activeSlug, episodeSlug, source);
        return { success: true };
    } catch (err) {
        markUploadFailed(activeSlug, episodeSlug);
        throw err;
    } finally {
        delete global[`prefetch_src_${activeSlug}_${episodeSlug}`];
        activeExtractions.delete(blobPath);
    }
}

const activePrefetchLoops = new Set();

/**
 * Prefetch sliding window — unduh episode dalam `upcomingUrls` satu per satu
 * secara sekuensial dengan jeda antar episode.
 * Logika: selalu jaga 2 episode ke depan sudah READY.
 * Jika ada upload Mega yang sedang berjalan, tunggu dulu.
 */
async function triggerPrefetchWindow(seriesSlug, upcomingUrls, seriesTitle, slugsToCheck = null) {
    if (!upcomingUrls || upcomingUrls.length === 0) return;

    const validUrls = upcomingUrls.filter(Boolean);
    if (validUrls.length === 0) return;

    const loopKey = `${seriesSlug}-${validUrls.join(',')}`;
    if (activePrefetchLoops.has(loopKey)) return;
    activePrefetchLoops.add(loopKey);

    try {

    for (const epUrl of validUrls) {
        try {
            const { episodeSlug, episodeSlugsToCheck } = extractSlugs(epUrl, null, null, null, null);
            // using activeSlug for checkUploadStatus is not perfectly robust here if seriesSlug is changed, but we assume seriesSlug is unified
            const checkInfo = await checkUploadStatusWithFallback([seriesSlug], episodeSlugsToCheck);
            const status = checkInfo.status;

            if (status === 'READY' || status === 'FAILED') {
                // Sudah done atau sudah gagal — skip
                // console.info(`[PrefetchWindow] Skip ${episodeSlug} — status: ${status}`);
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

            while (activeUploadExists || globalUploadCount >= 3) {
                if (prefetchAbortController.signal.aborted) {
                    console.info(`[PrefetchWindow] Dibatalkan oleh pengguna saat menunggu antrean untuk ${episodeSlug}`);
                    return;
                }

                if (activeUploadExists) {
                    console.info(`[PrefetchWindow] Series ${seriesSlug} masih memiliki upload yang berjalan. Menunda prefetch ${episodeSlug}...`);
                } else if (globalUploadCount >= 3) {
                    console.info(`[PrefetchWindow] VPS sedang sibuk (ada ${globalUploadCount} upload berjalan). Menunda prefetch ${episodeSlug}...`);
                }

                await new Promise(r => setTimeout(r, 10000)); // Cek setiap 10 detik

                activeUploadExists = hasActiveUploadForSeries(seriesSlug);
                globalUploadCount = getActiveUploadCount();
            }

            if (prefetchAbortController.signal.aborted) return;

            await prefetchOneEpisode(seriesSlug, epUrl, seriesTitle, 'prefetch', null, slugsToCheck);

            // Jeda antar episode untuk mencegah ETOOMANY dari Mega
            if (validUrls.indexOf(epUrl) < validUrls.length - 1) {
                console.info(`[PrefetchWindow] Jeda 30 detik sebelum prefetch episode berikutnya...`);
                await new Promise(r => setTimeout(r, 30000));
            }
        } catch (err) {
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
    const { episodeUrl, seriesUrl, nextEpisodeUrl, seriesTitle, episodeTitle, uniqueId } = req.query;
    if (!episodeUrl) {
        return res.status(400).json({ success: false, error: "Parameter 'episodeUrl' wajib diisi!" });
    }

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
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck);
            }
            return res.json({
                success: true,
                status: 'READY',
                url: getBlobUrl(getBlobPath(activeSlug, activeEpSlug))
            });
        }

        if (status === 'UPLOADING') {
            if (prefetchWindow.length > 0) {
                triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle, slugsToCheck);
            }

            let cachedProxyUrl = global[`proxy_${seriesSlug}_${episodeSlug}`];
            if (!cachedProxyUrl && global[`prefetch_src_${seriesSlug}_${episodeSlug}`]) {
                const src = global[`prefetch_src_${seriesSlug}_${episodeSlug}`];
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

        const blobPath = getBlobPath(activeSlug, activeEpSlug);
        if (activeExtractions.has(blobPath)) {
            return res.json({
                success: true,
                status: 'UPLOADING',
                message: 'Video sedang diekstrak di request lain.'
            });
        }

        // Status is FAILED or null -> Start extraction and upload process
        console.info(`[Smart-Play] Mulai ekstraksi server untuk: ${episodeUrl}`);

        activeExtractions.add(blobPath);
        let matchedSource = null;

        try {
            const result = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, '[Smart-Play]', req);
            matchedSource = result.matchedSource;

            if (!matchedSource) {
                activeExtractions.delete(blobPath);
                markUploadFailed(seriesSlug, episodeSlug);
                return res.status(404).json({
                    success: false,
                    status: 'FAILED',
                    message: result.error || 'Tidak ada server download/streaming yang ditemukan di halaman episode.'
                });
            }
        } catch (err) {
            activeExtractions.delete(blobPath);
            throw err;
        }

        if (matchedSource) {
            // Start upload in background, then chain prefetch window
            const uploadTask = uploadStream(matchedSource.url, matchedSource.headers, seriesSlug, episodeSlug);

            // Pastikan selalu ada .catch() agar Node tidak crash jika terjadi unhandled rejection
            if (uploadTask) {
                uploadTask.then(() => {
                    activeExtractions.delete(blobPath);
                    if (prefetchWindow.length > 0) {
                        console.info(`[Smart-Play] Upload selesai. Memulai prefetch window [${prefetchWindow.length} episode]...`);
                        triggerPrefetchWindow(seriesSlug, prefetchWindow, seriesTitle);
                    }
                }).catch(err => {
                    activeExtractions.delete(blobPath);
                    console.error(`[Smart-Play] Upload latar belakang gagal:`, err.message);
                });
            } else {
                activeExtractions.delete(blobPath);
            }

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            let proxyUrl = matchedSource.url;
            if (matchedSource.headers && matchedSource.headers.token) {
                proxyUrl = `${baseUrl}/api/proxy/kraken?url=${encodeURIComponent(matchedSource.url)}&token=${encodeURIComponent(matchedSource.headers.token)}&referer=${encodeURIComponent(matchedSource.headers.Referer || '')}`;
            } else if (!matchedSource.url.includes('.m3u8')) {
                proxyUrl = `${baseUrl}/api/proxy/filedon?url=${encodeURIComponent(matchedSource.url)}`;
            }

            // Simpan proxy URL sementara ke global (opsional)
            global[`proxy_${seriesSlug}_${episodeSlug}`] = proxyUrl;

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
        const count = cancelAllUploads();
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
        const { episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle } = req.query;
        if (!episodeUrl) return res.status(400).json({ success: false, message: "URL required" });
        
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
router.post('/cancel-stream', express.json(), async (req, res) => {
    const { url, seriesUrl, seriesTitle, uniqueId, episodeTitle } = req.body;
    if (!url) return res.json({ success: false });
    
    const { seriesSlug, episodeSlug, slugsToCheck, episodeSlugsToCheck } = extractSlugs(url, seriesUrl, seriesTitle, uniqueId, episodeTitle);
    const checkInfo = await checkUploadStatusWithFallback(slugsToCheck, episodeSlugsToCheck);
    const activeSlug = checkInfo.activeSeriesSlug || seriesSlug;
    const activeEpSlug = checkInfo.activeEpisodeSlug || episodeSlug;

    const blobPath = getBlobPath(activeSlug, activeEpSlug);
    
    console.info(`[Smart-Play] Eksplisit cancel dari client untuk: ${activeEpSlug}`);
    cancelUpload(activeSlug, activeEpSlug);
    activeExtractions.delete(blobPath);
    
    return res.json({ success: true });
});

// ============================================================
// RUTE QUEUE: Background Download Manager
// ============================================================

router.post('/api/queue/add', express.json(), async (req, res) => {
    try {
        const { episodeUrl, seriesUrl, seriesTitle, episodeTitle, uniqueId } = req.body;
        if (!episodeUrl) return res.status(400).json({ success: false, error: "episodeUrl diperlukan" });
        
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
            const { seriesSlug, episodeSlug } = extractSlugs(task.episodeUrl, task.seriesUrl, task.seriesTitle, task.uniqueId);
            
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
