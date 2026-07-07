import { resolveCanonicalUniqueId } from './canonicalService.js';
import { extractSlugs } from './slugService.js';
import { findBestVideoSource } from './streamRankingService.js';
import { checkUploadStatusWithFallback, getBlobPath } from './stream/blobStorageService.js';
import { markUploadFailed, hasActiveUploadForSeries, getActiveUploadCount } from './stream/uploadProgressService.js';
import { uploadStream } from './stream/ffmpegStreamService.js';
import { getCache } from '../utils/cacheManager.js';
import { getUnifiedAnimeEpisodes } from './animeOrchestrator.js';
import { extractEpNum } from '../utils/stringUtils.js';
import { backgroundQueue } from '../utils/queueManager.js';

export const proxyCache = getCache('proxy-cache', 3600); // Bersih otomatis setelah 1 jam
export const activeExtractions = new Set();
export let prefetchAbortController = new AbortController();

export function resetPrefetchAbortController() {
    prefetchAbortController = new AbortController();
    return prefetchAbortController;
}

export function abortAndResetPrefetch() {
    if (prefetchAbortController) {
        prefetchAbortController.abort();
    }
    prefetchAbortController = new AbortController();
    return prefetchAbortController;
}

export async function waitForUploadCompletion(slugsToCheck, episodeSlugsToCheck, item) {
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
    
    // Jalankan prefetchOneEpisode dengan source 'queue' dan bawa slugsToCheck, episodeTitle, dan uniqueId yang sudah resolved
    const result = await prefetchOneEpisode(item.seriesSlug, item.episodeUrl, item.seriesTitle, 'queue', null, slugsToCheck, item.episodeTitle, item.uniqueId);
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

export function isCurrentlyExtracting(checkSlugs, episodeSlugs) {
    const sList = Array.isArray(checkSlugs) ? checkSlugs : [checkSlugs].filter(Boolean);
    const eList = Array.isArray(episodeSlugs) ? episodeSlugs : [episodeSlugs].filter(Boolean);
    for (const s of sList) {
        for (const e of eList) {
            if (activeExtractions.has(getBlobPath(s, e))) return true;
        }
    }
    return false;
}

export function addActiveExtractions(checkSlugs, episodeSlugs) {
    const sList = Array.isArray(checkSlugs) ? checkSlugs : [checkSlugs].filter(Boolean);
    const eList = Array.isArray(episodeSlugs) ? episodeSlugs : [episodeSlugs].filter(Boolean);
    for (const s of sList) {
        for (const e of eList) {
            activeExtractions.add(getBlobPath(s, e));
        }
    }
}

export function removeActiveExtractions(checkSlugs, episodeSlugs) {
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
export async function prefetchOneEpisode(seriesSlug, episodeUrl, seriesTitle, source = 'player', oldSeriesSlug = null, slugsToCheck = null, episodeTitle = '', uniqueId = null, customSignal = null, preloadedUrlsObj = null) {
    uniqueId = await resolveCanonicalUniqueId(null, episodeUrl, seriesTitle, uniqueId);
    // Global Slug Normalization: selalu teruskan seriesTitle & uniqueId agar slugsToCheck dan episodeSlugsToCheck konsisten 100% di seluruh pipeline
    const { seriesSlug: extractedSeriesSlug, episodeSlug, oldSeriesSlug: extractedOldSlug, slugsToCheck: extractedSlugs, episodeSlugsToCheck } = extractSlugs(episodeUrl, null, seriesTitle, uniqueId, episodeTitle); 
    
    // BUGFIX: Selalu gunakan extractedSlugs (yang mengandung mal-XXXXX) dari uniqueId yang sudah resolved.
    // Jangan gunakan slugsToCheck dari caller karena mungkin belum mengandung uniqueId yang resolved.
    const checkSlugs = extractedSlugs && extractedSlugs.length > 0 ? extractedSlugs : [seriesSlug, oldSeriesSlug, extractedSeriesSlug, extractedOldSlug].filter(Boolean);
    // Tambahkan slugsToCheck dari caller (jika ada) sebagai fallback tambahan tanpa menggantikan yang utama
    if (slugsToCheck && slugsToCheck.length > 0) {
        for (const s of slugsToCheck) {
            if (s && !checkSlugs.includes(s)) checkSlugs.push(s);
        }
    }
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
        let urlsObjForAttempt = preloadedUrlsObj;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                if (activeSignal && activeSignal.aborted) {
                    console.info(`${logPrefix} Dibatalkan oleh pengguna sebelum percobaan ${attempt}.`);
                    removeActiveExtractions(checkSlugs, episodeSlugsToCheck);
                    return { success: false, reason: 'UPLOAD_CANCELLED' };
                }

                const attemptPrefix = attempt > 1 ? `${logPrefix} [Retry ${attempt}/${maxAttempts}]` : logPrefix;

                // BUGFIX: Selalu cek dan gabungkan URL dari Orchestrator jika jumlah provider kurang dari 3.
                // Ini memastikan findBestVideoSource selalu mencoba 1080p dari Samehadaku/Kuronime,
                // meskipun frontend hanya mengirimkan 1 atau 2 provider di query params.
                if ((!urlsObjForAttempt || Object.keys(urlsObjForAttempt).length < 3) && (uniqueId || seriesTitle)) {
                    try {
                        const epNum = extractEpNum(episodeTitle || episodeUrl);
                        if (epNum != null) {
                            const orchSlug = uniqueId ? uniqueId.toString().replace(/^(mal-|db-)/, '') : seriesTitle;
                            const animeData = await getUnifiedAnimeEpisodes({ slug: orchSlug, forceRefresh: false }).catch(async () => {
                                if (seriesTitle) {
                                    return getUnifiedAnimeEpisodes({ slug: seriesTitle, forceRefresh: false }).catch(() => null);
                                }
                                return null;
                            });
                            const targetEp = animeData?.episodes?.find(e => e.num === epNum);
                            if (targetEp?.urls && Object.keys(targetEp.urls).length > 0) {
                                urlsObjForAttempt = { ...(urlsObjForAttempt || {}), ...targetEp.urls };
                                console.info(`${attemptPrefix} ✓ Orchestrator memperbarui URL menjadi ${Object.keys(urlsObjForAttempt).length} provider untuk multi-source fetch (ep ${epNum}).`);
                            }
                        }
                    } catch (orchErr) {}
                }

                const result = await findBestVideoSource(episodeUrl, seriesTitle, episodeTitle, attemptPrefix, null, urlsObjForAttempt);
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
export async function triggerPrefetchWindow(seriesSlug, upcomingUrls, seriesTitle, slugsToCheck = null, uniqueId = null) {
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
                // BUGFIX: Selalu prioritaskan extractedSlugs (mengandung mal-XXXXX) dari uniqueId yang sudah resolved.
                // slugsToCheck dari parameter hanya sebagai fallback tambahan.
                const checkSlugs = extractedSlugs && extractedSlugs.length > 0 ? extractedSlugs : (slugsToCheck && slugsToCheck.length > 0 ? slugsToCheck : [seriesSlug]);
                if (slugsToCheck && slugsToCheck.length > 0) {
                    for (const s of slugsToCheck) {
                        if (s && !checkSlugs.includes(s)) checkSlugs.push(s);
                    }
                }
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
